import { App, Notice, TFile, normalizePath, stringifyYaml } from "obsidian";
import { MiniManagerSettings } from "../settings/MiniManagerSettings";
import { MMFApiService } from "./MMFApiService";
import { MMFObject } from "../models/MMFObject";
import { DownloadManager } from "./DownloadManager";
import { LoggerService } from "./LoggerService";
import { OAuth2Service } from "./OAuth2Service";
import { ValidationService } from "./ValidationService";
import { ACTIVE_STATES, COMPLETED_STATE, CANCELLED_STATE, FileStateService } from "./FileStateService";
import { AuthenticationError, HttpError } from "../models/Errors";
import { ImageDownloadService, getImageUrl } from "./downloads/ImageDownloadService";
import { FileDownloadService } from "./downloads/FileDownloadService";
import { formatFileSize } from "../utils/format";
import { abortError, ensureFolder, fileExists, folderExists } from "../utils/vault";

/** `app.setting` is not part of the public API. */
interface AppWithSettings extends App {
	setting: {
		open(): void;
		openTabById(id: string): void;
	};
}

export class MMFDownloader {
	private app: App;
	private settings: MiniManagerSettings;
	private apiService: MMFApiService;
	private downloadManager: DownloadManager;
	private logger: LoggerService;
	private oauth2Service: OAuth2Service;
	private validationService: ValidationService;
	private fileStateService: FileStateService;
	private imageDownloadService: ImageDownloadService;
	private fileDownloadService: FileDownloadService;
	private pluginDir: string;
	private cancellationTokens: Map<string, AbortController> = new Map(); // For actual request cancellation
	private isPaused: boolean = false;
	/** Whether the user has already been told to log in again since downloads last resumed. */
	private authNoticeShown: boolean = false;
	private isProcessing: boolean = false;
	/** Set when the queue is prompted mid-pass, so the pass runs again rather than miss work. */
	private processAgain: boolean = false;
	private readonly yieldDelayMs = 0;

	constructor(
		app: App,
		settings: MiniManagerSettings,
		logger: LoggerService,
		oauth2Service: OAuth2Service,
		apiService: MMFApiService,
		validationService: ValidationService,
		fileStateService: FileStateService,
		downloadManager: DownloadManager,
		pluginDir: string
	) {
		this.app = app;
		this.settings = settings;
		this.logger = logger;
		this.oauth2Service = oauth2Service;
		this.apiService = apiService;
		this.validationService = validationService;
		this.fileStateService = fileStateService;
		this.downloadManager = downloadManager;
		this.pluginDir = pluginDir;
		this.imageDownloadService = new ImageDownloadService(this.app, this.logger, this.downloadManager);
		this.fileDownloadService = new FileDownloadService(this.app, this.settings, this.logger, this.downloadManager, this.oauth2Service);
	}

	/** Starts working through whatever is queued. Called once the plugin has loaded. */
	public start(): void {
		this._processQueue();
	}

	/** Stops starting new work and aborts what is in flight. Called when the plugin unloads. */
	public shutdown(): void {
		this.isPaused = true;
		this.cancellationTokens.forEach(controller => controller.abort());
	}

	/**
	 * Resumes downloads, first re-queueing the objects that failed on authentication.
	 * If the user still needs to log in, the queue pauses again as soon as it has work.
	 */
	public async resumeDownloads(): Promise<void> {
		this.logger.info("resumeDownloads called.");
		const retried = await this.requeue(['failure_auth']);
		if (this.isPaused) {
			new Notice('Resuming paused downloads...');
		} else {
			new Notice('Processing queued models...');
		}
		if (retried > 0) {
			new Notice(`Retrying ${retried} model${retried === 1 ? '' : 's'} that failed on authentication.`);
		}
		this.isPaused = false;
		this.authNoticeShown = false;
		this._processQueue();
	}

	/**
	 * Re-queues every failed object, whatever it failed on.
	 * @returns how many objects were re-queued.
	 */
	public async retryFailed(): Promise<number> {
		const retried = await this.requeue(this.fileStateService.getFailureStates());
		this.logger.info(`Re-queued ${retried} failed object(s).`);
		this._processQueue();
		return retried;
	}

	private async requeue(fromStates: string[]): Promise<number> {
		let count = 0;
		for (const state of fromStates) {
			for (const objectId of await this.fileStateService.getAll(state)) {
				await this.queue(objectId);
				count++;
			}
		}
		return count;
	}

	/** Puts an object at the back of the queue, keeping what is known about it. */
	private async queue(objectId: string): Promise<void> {
		await this.ensureJob(objectId);
		await this.fileStateService.add('all', objectId);
		await this.fileStateService.add('00_queued', objectId);
		await this.downloadManager.updateJob(objectId, '00_queued', 0, 'In queue...');
	}

	public pauseDownloads(): void {
		this.logger.info("pauseDownloads called.");
		if (!this.isPaused) {
			this.isPaused = true;
			new Notice('Downloads paused. You can resume anytime.');
		}
	}

	public isPausedState(): boolean {
		return this.isPaused;
	}

	private async yieldToEventLoop(): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, this.yieldDelayMs));
	}

	private async ensureJob(objectId: string): Promise<void> {
		if (this.downloadManager.getJob(objectId)) return;
		const placeholder: MMFObject = {
			id: objectId,
			name: `Object ${objectId}`,
			description: '',
			url: '',
			images: [],
			files: { total_count: 0, items: [] }
		};
		await this.downloadManager.addJob(placeholder);
	}

	/**
	 * Whether there is no point starting anything until the user logs in: a stored token
	 * that has expired is used for every request, and files cannot be fetched without one.
	 */
	private loginRequired(): boolean {
		if (this.oauth2Service.hasToken()) {
			return !this.oauth2Service.isAuthenticated();
		}
		return this.settings.downloadFiles && this.settings.useDirectDownload;
	}

	/** Pauses downloads until the user has logged in again, telling them once. */
	private pauseForAuth(): void {
		this.isPaused = true;
		if (this.authNoticeShown) return;
		this.authNoticeShown = true;

		const notice = new Notice('MyMiniFactory authentication expired. Please re-authenticate in the settings.', 0);
		const settingsButton = notice.noticeEl.createEl('button', {text: 'Open Settings'});
		settingsButton.addEventListener('click', () => {
			const setting = (this.app as AppWithSettings).setting;
			setting.open();
			setting.openTabById('mini-manager');
		});
	}

	/**
	 * Queues an object for download. An object that is already downloaded is validated
	 * again; one that failed or was cancelled is retried; one in progress is left alone.
	 */
	public async downloadObject(objectId: string): Promise<void> {
		const state = this.fileStateService.getState(objectId);
		if (state !== undefined && ACTIVE_STATES.includes(state)) {
			this.logger.info(`Object ${objectId} is already in progress (${state}).`);
			return;
		}

		await this.queue(objectId);
		this._processQueue();
	}

	/**
	 * Throws away what is on disk for an object and downloads it again. An object that is
	 * being downloaded right now is left alone.
	 * @returns whether the object was queued.
	 */
	public async redownload(objectId: string, folderPath: string): Promise<boolean> {
		const state = this.fileStateService.getState(objectId);
		if (state !== undefined && ACTIVE_STATES.includes(state)) {
			this.logger.info(`Object ${objectId} is already in progress (${state}); not re-downloading.`);
			return false;
		}

		await this.fileStateService.add('retried', objectId);
		if (await this.app.vault.adapter.exists(folderPath)) {
			await this.app.vault.adapter.rmdir(folderPath, true);
		}
		await this.queue(objectId);
		this._processQueue();
		return true;
	}

	public async startBulkDownload(): Promise<void> {
		const bulkFilePath = normalizePath(`${this.pluginDir}/bulk-downloads.txt`);
		if (!await this.app.vault.adapter.exists(bulkFilePath)) {
			new Notice(`Bulk download file not found at ${bulkFilePath}`);
			return;
		}

		new Notice('Starting bulk download...');
		const fileContent = await this.app.vault.adapter.read(bulkFilePath);
		const ids = fileContent.split(',').map(id => id.trim()).filter(id => id);

		for (const id of ids) {
			if (this.fileStateService.getState(id) === COMPLETED_STATE) {
				this.logger.info(`Skipping already completed object ${id}`);
				continue;
			}
			// Leaves objects in progress alone; queues new, failed and cancelled ones.
			await this.downloadObject(id);
		}
	}

	public async cancelDownload(objectId: string): Promise<void> {
		this.logger.info(`Attempting to cancel download for ${objectId}`);
		const abortController = this.cancellationTokens.get(objectId);
		if (abortController) {
			abortController.abort();
		}

		// A task still running for this object finds it is no longer in the state it expects
		// and stops there.
		await this.fileStateService.moveAcrossStates(ACTIVE_STATES, CANCELLED_STATE, objectId);
		await this.downloadManager.forgetJob(objectId);

		new Notice(`Download for ${objectId} cancelled.`);
		this.logger.info(`Download for object ${objectId} cancelled.`);
		this._processQueue(); // See if a new download can start
	}

	/**
	 * Starts as much queued work as there are free slots for. Safe to call at any time:
	 * a call made while a pass is running makes that pass run again when it finishes.
	 */
	private async _processQueue(): Promise<void> {
		if (this.isProcessing) {
			this.processAgain = true;
			return;
		}
		this.isProcessing = true;

		try {
			do {
				this.processAgain = false;
				await this.dispatch();
			} while (this.processAgain);
		} catch (error) {
			this.logger.error(`Download queue failed: ${error.message}`);
		} finally {
			this.isProcessing = false;
		}
	}

	private async dispatch(): Promise<void> {
		// --- Heavy Task Pool (File Downloads) ---
		const activeFileDownloads = (await this.fileStateService.getAll('70_downloading')).length;
		let availableFileSlots = this.settings.maxConcurrentDownloads - activeFileDownloads;
		while (availableFileSlots > 0 && !this.isPaused) {
			const objectId = (await this.fileStateService.getAll('60_images_downloaded'))[0];
			if (objectId === undefined) break;

			if (await this.begin(objectId, '60_images_downloaded', '70_downloading')) {
				this._runFileDownload(objectId); // fire and forget
				availableFileSlots--;
				await this.yieldToEventLoop();
			}
		}

		// --- Light Task Pool (Validation, Prep, Images) ---
		const activeLightTasks = (await this.fileStateService.getAll('10_validating')).length +
								(await this.fileStateService.getAll('30_preparing')).length +
								(await this.fileStateService.getAll('50_downloading_images')).length;
		let availableLightSlots = this.settings.maxConcurrentLightTasks - activeLightTasks;

		while (availableLightSlots > 0 && !this.isPaused) {
			// Prioritize tasks further down the pipeline
			const readyForImages = (await this.fileStateService.getAll('40_prepared'))[0];
			const readyForPrep = (await this.fileStateService.getAll('20_validated'))[0];
			const queued = (await this.fileStateService.getAll('00_queued'))[0];

			let started: boolean;
			if (readyForImages !== undefined) {
				started = await this.begin(readyForImages, '40_prepared', '50_downloading_images');
				if (started) this._runImageDownload(readyForImages);
			} else if (readyForPrep !== undefined) {
				started = await this.begin(readyForPrep, '20_validated', '30_preparing');
				if (started) this._runPreparation(readyForPrep);
			} else if (queued !== undefined) {
				started = await this.begin(queued, '00_queued', '10_validating');
				if (started) this._runValidation(queued);
			} else {
				break; // No more light tasks to start
			}

			if (started) {
				availableLightSlots--;
				await this.yieldToEventLoop();
			}
		}
	}

	/**
	 * Claims an object for its next stage.
	 * @returns false if it should not be started: the user has to log in first, in which
	 * case the object stays where it is and downloads pause, or the object has just been
	 * taken out of `fromState` (cancelled, say).
	 */
	private async begin(objectId: string, fromState: string, toState: string): Promise<boolean> {
		if (this.loginRequired()) {
			this.logger.warn("Not logged in to MyMiniFactory; pausing downloads until the user re-authenticates.");
			this.pauseForAuth();
			return false;
		}
		await this.ensureJob(objectId);
		return this.fileStateService.move(fromState, toState, objectId);
	}

	/** Ends a task: drops its cancellation token and looks for more work. */
	private finishTask(objectId: string, abortController: AbortController): void {
		// The object may have been cancelled and requested again while this task was
		// finishing, in which case the token registered now belongs to the newer task.
		if (this.cancellationTokens.get(objectId) === abortController) {
			this.cancellationTokens.delete(objectId);
		}
		this._processQueue();
	}

	private async _runErrorHandler(objectId: string, error: Error, fromState: string) {
		if (error.name === 'AbortError') {
			this.logger.info(`Download for object ${objectId} was aborted.`);
			// cancelDownload handles moving to 'cancelled' state.
			return;
		}

		this.logger.error(`Failed to download object ${objectId}: ${error.message}`);

		let failureState = 'failure_unknown';
		if (error instanceof AuthenticationError) {
			failureState = 'failure_auth';
			this.pauseForAuth();
		} else if (error instanceof HttpError) {
			failureState = `failure_code_${error.status}`;
		}

		// Not moved means the object was cancelled or re-queued while this task was running.
		if (await this.fileStateService.move(fromState, failureState, objectId)) {
			await this.downloadManager.updateJob(objectId, 'failed', 100, "Failed", error.message);
		}
	}

	private async _runValidation(objectId: string): Promise<void> {
		const abortController = new AbortController();
		this.cancellationTokens.set(objectId, abortController);
		try {
			await this.downloadManager.updateJob(objectId, '10_validating', 5, 'Validating...');
			this.logger.info(`(model ${objectId}) State updated to 'validating'`);
			const validationResult = await this.validationService.validateAndGetResult(objectId);
			if (abortController.signal.aborted) throw abortError();

			if (validationResult && validationResult.isValid) {
				if (await this.fileStateService.move('10_validating', COMPLETED_STATE, objectId)) {
					await this.downloadManager.updateJobObject(objectId, validationResult.object);
					await this.downloadManager.updateJob(objectId, '80_completed', 100, 'Model already downloaded and valid');
				}
				this.logger.info(`(model ${objectId}) State updated to 'complete'`);
				return;
			}

			if (validationResult) {
				const errors = validationResult.errors.join(', ');
				if (fileExists(this.app, this.manualInstructionsPath(validationResult.folderPath))) {
					// The user was asked to put files in this folder by hand; keep whatever is there.
					this.logger.info(`Validation failed for object ${objectId}. Downloading what is missing. Errors: ${errors}`);
				} else {
					this.logger.info(`Validation failed for object ${objectId}. Deleting folder and re-downloading. Errors: ${errors}`);
					await this.validationService.deleteObjectFolder(validationResult.folderPath);
				}
			}
			await this.fileStateService.move('10_validating', '20_validated', objectId); // Ready for prep
			this.logger.info(`(model ${objectId}) State updated to 'validated' (needs downloading)`);
		} catch (error) {
			await this._runErrorHandler(objectId, error, '10_validating');
		} finally {
			this.finishTask(objectId, abortController);
		}
	}

	private async _runPreparation(objectId: string): Promise<void> {
		const abortController = new AbortController();
		this.cancellationTokens.set(objectId, abortController);
		try {
			await this.downloadManager.updateJob(objectId, '30_preparing', 10, 'Preparing metadata...');

			this.logger.info(`Attempting to retrieve object ${objectId}`);
			const object = await this.apiService.getObjectById(objectId);
			if (abortController.signal.aborted) throw abortError();

			await this.downloadManager.updateJobObject(objectId, object);

			await this.downloadManager.updateJob(objectId, '30_preparing', 20, "Creating folders...");
			const objectFolder = await this.createObjectFolder(object);
			// Persist real metadata early so later steps (and retries) know the correct folder/name
			await this.saveMetadataFile(object, objectFolder);
			if (abortController.signal.aborted) throw abortError();

			// now ready for image download
			await this.fileStateService.move('30_preparing', '40_prepared', objectId);

		} catch (error) {
			await this._runErrorHandler(objectId, error, '30_preparing');
		} finally {
			this.finishTask(objectId, abortController);
		}
	}

	private async _runImageDownload(objectId: string): Promise<void> {
		const abortController = new AbortController();
		this.cancellationTokens.set(objectId, abortController);
		try {
			const job = this.downloadManager.getJob(objectId);
			if (!job) throw new Error(`Job not found for object ID ${objectId}`);

			await this.downloadManager.updateJob(objectId, '50_downloading_images', 30, 'Downloading images...');

			const objectFolder = await this.createObjectFolder(job.object); // Re-create path, it's idempotent

			if (this.settings.downloadImages) {
				await this.imageDownloadService.downloadImages(job, job.object, objectFolder, abortController.signal);
			}

			await this.fileStateService.move('50_downloading_images', '60_images_downloaded', objectId);

		} catch (error) {
			await this._runErrorHandler(objectId, error, '50_downloading_images');
		} finally {
			this.finishTask(objectId, abortController);
		}
	}

	private async _runFileDownload(objectId: string): Promise<void> {
		const abortController = new AbortController();
		this.cancellationTokens.set(objectId, abortController);
		try {
			const job = this.downloadManager.getJob(objectId);
			if (!job) throw new Error(`Job not found for object ID ${objectId}`);

			await this.downloadManager.updateJob(objectId, '70_downloading', 70, 'Downloading files...');

			const objectFolder = await this.createObjectFolder(job.object);

			if (this.settings.downloadFiles) {
				await this.fileDownloadService.downloadFiles(job, job.object, objectFolder, abortController.signal);
			}
			if (abortController.signal.aborted) throw abortError();

			// Create metadata files at the very end
			await this.downloadManager.updateJob(job.id, '70_downloading', 90, "Creating metadata files...");

			let mainLocalImagePath: string | undefined;
			const imagesPath = normalizePath(`${objectFolder}/images`);
			if (folderExists(this.app, imagesPath)) {
				const imageFiles = (await this.app.vault.adapter.list(imagesPath)).files;
				if (imageFiles.length > 0) {
					mainLocalImagePath = imageFiles[0];
				}
			}

			await this.createMetadataFile(job.object, objectFolder, mainLocalImagePath);
			await this.saveMetadataFile(job.object, objectFolder);

			// Left by an earlier failed attempt; every file is in place now.
			const manualInstructionsPath = this.manualInstructionsPath(objectFolder);
			if (await this.app.vault.adapter.exists(manualInstructionsPath)) {
				await this.app.vault.adapter.remove(manualInstructionsPath);
			}

			if (await this.fileStateService.move('70_downloading', COMPLETED_STATE, objectId)) {
				await this.downloadManager.updateJob(objectId, '80_completed', 100, 'Completed');
			}

		} catch (error) {
			// An auth failure is retried once the user logs in again; anything else may need
			// the user to fetch the files by hand.
			if (error.name !== 'AbortError' && !(error instanceof AuthenticationError)) {
				try {
					const job = this.downloadManager.getJob(objectId);
					if (job) {
						const objectFolder = await this.createObjectFolder(job.object);
						await this.createEmergencyInstructions(objectId, job.object, objectFolder, error);
					}
				} catch (instructionsError) {
					this.logger.error(`Failed to create instructions file: ${instructionsError.message}`);
				}
			}
			await this._runErrorHandler(objectId, error, '70_downloading');

		} finally {
			this.finishTask(objectId, abortController);
		}
	}


	/**
	 * Create emergency download instructions when everything else fails
	 */
	private async createEmergencyInstructions(
		objectId: string,
		object: MMFObject,
		objectFolder: string,
		error: Error
	): Promise<void> {
		const filesPath = normalizePath(`${objectFolder}/files`);
		await ensureFolder(this.app, filesPath);

		// Ensure we have a web URL for manual downloads
		const webUrl = object.url || `https://www.myminifactory.com/object/${objectId}`;

		const instructionsPath = this.manualInstructionsPath(objectFolder);
		let instructionsContent = `# Manual Download Required\n\n`;
		instructionsContent += `The plugin encountered API errors when downloading "${object.name || `Object ${objectId}`}".\n\n`;

		instructionsContent += `## About This Object\n\n`;
		instructionsContent += `- **Object ID**: ${objectId}\n`;
		if (object.name) instructionsContent += `- **Name**: ${object.name}\n`;
		if (object.designer && object.designer.name) instructionsContent += `- **Designer**: ${object.designer.name}\n`;

		instructionsContent += `\n## Steps to Download Files\n\n`;
		instructionsContent += `1. Visit the object page on MyMiniFactory: [${object.name || `Object ${objectId}`}](${webUrl})\n`;
		instructionsContent += `2. Log in to your MyMiniFactory account\n`;
		instructionsContent += `3. Use the download button on the website\n`;
		instructionsContent += `4. Place them in the files subfolder of this directory\n`;

		instructionsContent += `## Technical Details\n\n`;
		instructionsContent += `Error: ${error.message}\n\n`;
		instructionsContent += `Time: ${new Date().toLocaleString()}\n\n`;
		instructionsContent += `This error may be due to one or more of the following:\n\n`;
		instructionsContent += `- API changes or outage at MyMiniFactory\n`;
		instructionsContent += `- The object ID may be incorrect\n`;
		instructionsContent += `- The object may require purchase\n`;
		instructionsContent += `- Your API key may not have sufficient permissions\n`;
		instructionsContent += `- The object may have been removed or made private\n\n`;

		instructionsContent += `Try updating the plugin or checking the [MyMiniFactory API documentation](https://www.myminifactory.com/settings/developer) for more information.`;

		if (!fileExists(this.app, instructionsPath)) {
			await this.app.vault.create(instructionsPath, instructionsContent);
		}
		this.logger.info("Created emergency download instructions file");
	}

	private manualInstructionsPath(objectFolder: string): string {
		return normalizePath(`${objectFolder}/files/MANUAL_DOWNLOAD_REQUIRED.md`);
	}

	private async createObjectFolder(object: MMFObject): Promise<string> {
		// Create base download folder if it doesn't exist
		const basePath = normalizePath(this.settings.downloadPath);
		await ensureFolder(this.app, basePath);

		const designerName = object.designer ? this.sanitizePath(object.designer.name) : "Unknown";

		// Create designer folder
		const designerPath = normalizePath(`${basePath}/${designerName}`);
		await ensureFolder(this.app, designerPath);

		// Create object folder
		const objectPath = normalizePath(`${designerPath}/${this.sanitizePath(object.name)}`);
		await ensureFolder(this.app, objectPath);

		return objectPath;
	}

	private async createMetadataFile(object: MMFObject, folderPath: string, mainLocalImagePath?: string): Promise<void> {
		const filePath = normalizePath(`${folderPath}/README.md`);

		const frontmatter: any = {
			name: object.name,
			site_url: object.url,
			description: object.description,
			tags: object.tags || [],
		};

		if (object.designer) {
			frontmatter.designer = object.designer.name;
		}
		if (mainLocalImagePath) {
			frontmatter.main_image = mainLocalImagePath;
		}

		const frontmatterString = stringifyYaml(frontmatter);

		let content = `---\n${frontmatterString}---\n\n`;

		content += `# ${object.name}\n\n`;
		if (object.images && object.images.length > 0) {
			const mainImage = object.images.find(img => img.is_primary) || object.images[0];
			if (mainImage) {
				content += `![Main Image](${getImageUrl(mainImage) || ""})\n\n`;
			}
		}

		if (object.designer) {
			content += `## Designer: ${object.designer.name}\n\n`;
		}
		if (object.publishedAt) {
			content += `- **Published:** ${new Date(object.publishedAt).toLocaleDateString()}\n`;
		}
		content += `- **MMF URL:** [${object.url}](${object.url})\n`;
		if (object.license) {
			content += `- **License:** ${object.license}\n`;
		}
		if (object.downloadsCount) {
			content += `- **Downloads:** ${object.downloadsCount}\n`;
		}
		if (object.likesCount) {
			content += `- **Likes:** ${object.likesCount}\n\n`;
		}

		content += `## Description\n\n${object.description}\n\n`;

		if (object.tags && object.tags.length > 0) {
			content += `## Tags\n\n`;
			object.tags.forEach(tag => {
				content += `- ${tag}\n`;
			});
			content += '\n';
		}

		if (object.categories && object.categories.length > 0) {
			content += `## Categories\n\n`;
			object.categories.forEach(category => {
				content += `- ${category}\n`;
			});
			content += '\n';
		}

		if (object.files && object.files.items && object.files.items.length > 0) {
			content += `## Files\n\n`;
			object.files.items.forEach(file => {
				content += `- ${file.filename} (${formatFileSize(file.size)})\n`;
			});
		}

		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (file && file instanceof TFile) {
			await this.app.vault.modify(file, content);
		} else {
			await this.app.vault.create(filePath, content);
		}
	}

	private async saveMetadataFile(object: MMFObject, folderPath: string): Promise<void> {
		const filePath = normalizePath(`${folderPath}/mmf-metadata.json`);
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (file && file instanceof TFile) {
			await this.app.vault.modify(file, JSON.stringify(object, null, 2));
		} else {
			await this.app.vault.create(filePath, JSON.stringify(object, null, 2));
		}
	}

	private sanitizePath(path: string): string {
		// Replace illegal characters and ensure no trailing dots/spaces which are disallowed on some filesystems
		return path.replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/, '').trim();
	}
}
