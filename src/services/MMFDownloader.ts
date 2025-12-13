import { App, Notice, TFile, TFolder, normalizePath, stringifyYaml } from "obsidian";
import { MiniManagerSettings } from "../settings/MiniManagerSettings";
import { MMFApiService } from "./MMFApiService";
import { MMFObject } from "../models/MMFObject";
import { DownloadManager, DownloadJob } from "./DownloadManager";
import { LoggerService } from "./LoggerService";
import { OAuth2Service } from "./OAuth2Service";
import { ValidationService } from "./ValidationService";
import { FileStateService } from "./FileStateService";
import { AuthenticationError, HttpError } from "../models/Errors";
import { ImageDownloadService } from "./downloads/ImageDownloadService";
import { FileDownloadService } from "./downloads/FileDownloadService";

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
	private cancellationTokens: Map<string, AbortController> = new Map(); // For actual request cancellation
	private isPaused: boolean = false;
	private isProcessing: boolean = false;
	private isFileDownloadsPaused: boolean = false;
	private readonly yieldDelayMs = 0;

	constructor(app: App, settings: MiniManagerSettings, logger: LoggerService, oauth2Service: OAuth2Service, validationService: ValidationService) {
		this.app = app;
		this.settings = settings;
		this.logger = logger;
		this.oauth2Service = oauth2Service;
		this.validationService = validationService;
		this.apiService = new MMFApiService(settings, logger, oauth2Service);
		this.fileStateService = FileStateService.getInstance(this.app, this.logger);
		this.downloadManager = DownloadManager.getInstance(this.fileStateService);
		this.imageDownloadService = new ImageDownloadService(this.app, this.settings, this.logger, this.downloadManager, this.handleAuthError.bind(this));
		this.fileDownloadService = new FileDownloadService(
			this.app,
			this.settings,
			this.logger,
			this.downloadManager,
			this.oauth2Service,
			this.fileStateService,
			this.handleAuthError.bind(this),
			this.pauseFileDownloads.bind(this),
			this.formatFileSize.bind(this),
			this.handleFileForbidden.bind(this)
		);
	}

	public resumeDownloads(): void {
		this.logger.info("resumeDownloads called.");
		this.isProcessing = false; // Force reset the processing flag
		if (this.isPaused) {
			this.isPaused = false;
			new Notice('Resuming paused downloads...');
		} else {
			new Notice('Processing 00_queued models...');
		}
		this.isFileDownloadsPaused = false;
		this._processQueue();
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

	private pauseFileDownloads(message?: string) {
		this.isFileDownloadsPaused = true;
		const noticeMsg = message || 'File downloads paused after server error. Resume when ready.';
		new Notice(noticeMsg);
		this.logger.warn(noticeMsg);
	}

	private async handleFileForbidden(jobId: string): Promise<void> {
		await this.fileStateService.move('70_downloading', 'failure_code_403', jobId);
		await this.downloadManager.updateJob(jobId, 'failed', 100, 'Forbidden (403) during file download');
		this.isProcessing = false;
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
		await this.downloadManager.updateJob(objectId, '00_queued', 0, 'In queue...');
	}

	private handleAuthError(): void {
		this.isPaused = true;
		const notice = new Notice('MyMiniFactory authentication expired. Please re-authenticate in the settings.', 0);
		const settingsButton = notice.noticeEl.createEl('button', {text: 'Open Settings'});
		settingsButton.addEventListener('click', () => {
			this.app.setting.open();
			this.app.setting.openTabById('mini-manager');
		});
	}

	public async downloadObject(objectId: string): Promise<void> {
		await this.fileStateService.add('all', objectId);

		const tempObject: MMFObject = {
			id: objectId,
			name: `Object ${objectId}`,
			description: '',
			url: '',
			images: [],
			files: {
				total_count: 0,
				items: []
			}
		};

		const job = await this.downloadManager.addJob(tempObject);
		if (this.isPaused) {
			new Notice('Downloads are paused. Please re-authenticate and resume.');
			return;
		}

		await this.downloadManager.updateJob(job.id, '00_queued', 0, 'In queue...');
		await this.fileStateService.add('00_queued', objectId);
		this._processQueue();
	}

	public async startBulkDownload(): Promise<void> {
		const bulkFilePath = normalizePath(`${this.app.vault.configDir}/plugins/mini-manager/bulk-downloads.txt`);
		if (!await this.app.vault.adapter.exists(bulkFilePath)) {
			new Notice(`Bulk download file not found at ${bulkFilePath}`);
			return;
		}

		new Notice('Starting bulk download...');
		const fileContent = await this.app.vault.adapter.read(bulkFilePath);
		const ids = fileContent.split(',').map(id => id.trim()).filter(id => id);

		for (const id of ids) {
			const existingJob = this.downloadManager.getJob(id);
			if (existingJob) {
				if (existingJob.status === '80_completed') {
					this.logger.info(`Skipping already 80_completed job ${id}`);
					continue;
				} else if (existingJob.status === 'failed') {
					this.logger.info(`Retrying failed job ${id}`);
					this.downloadManager.removeJob(id);
					await this.fileStateService.remove('failed', id);
				} else {
					this.logger.info(`Skipping already 00_queued/downloading job ${id}`);
					continue;
				}
			}
			// This will now add to the file queue
			await this.downloadObject(id);
		}
	}

	public async cancelDownload(objectId: string): Promise<void> {
		this.logger.info(`Attempting to cancel download for ${objectId}`);
		const abortController = this.cancellationTokens.get(objectId);
		if (abortController) {
			abortController.abort();
		}

		// Move to a 'cancelled' state from any of the active states
		await this.fileStateService.moveAcrossStates(
			['00_queued', '10_validating', '30_preparing', '50_downloading_images', '70_downloading'],
			'cancelled',
			objectId
		);

		this.downloadManager.removeJob(objectId);
		new Notice(`Download for ${objectId} cancelled.`);
		this.logger.info(`Download for object ${objectId} cancelled.`);
		this._processQueue(); // See if a new download can start
	}

	private async _processQueue(): Promise<void> {
		// this.logger.info(`_processQueue called. isPaused: ${this.isPaused}, isProcessing: ${this.isProcessing}`);
		if (this.isPaused || this.isProcessing) {
			return;
		}
		this.isProcessing = true;
		// this.logger.info(`_processQueue: set isProcessing to true.`);

		try {
			// --- Heavy Task Pool (File Downloads) ---
			const activeFileDownloads = (await this.fileStateService.getAll('70_downloading')).length;
			let availableFileSlots = this.settings.maxConcurrentDownloads - activeFileDownloads;
			if (this.isFileDownloadsPaused) {
				availableFileSlots = 0;
				this.logger.info("File downloads paused; skipping heavy task dispatch.");
			}
			while (availableFileSlots > 0) {
				const readyForFiles = await this.fileStateService.getAll('60_images_downloaded');
				if (readyForFiles.length === 0) break;

				const objectId = readyForFiles[0];
				await this.ensureJob(objectId);
				await this.fileStateService.move('60_images_downloaded', '70_downloading', objectId);
				this._runFileDownload(objectId); // fire and forget
				availableFileSlots--;
				await this.yieldToEventLoop();
			}

			// --- Light Task Pool (Validation, Prep, Images) ---
			const activeLightTasks = (await this.fileStateService.getAll('10_validating')).length +
									(await this.fileStateService.getAll('30_preparing')).length +
									(await this.fileStateService.getAll('50_downloading_images')).length;
			let availableLightSlots = this.settings.maxConcurrentLightTasks - activeLightTasks;

			while (availableLightSlots > 0) {
				// Prioritize tasks further down the pipeline
				const readyForImages = await this.fileStateService.getAll('40_prepared');
				if (readyForImages.length > 0) {
					const objectId = readyForImages[0];
					await this.ensureJob(objectId);
					await this.fileStateService.move('40_prepared', '50_downloading_images', objectId);
					this._runImageDownload(objectId);
					availableLightSlots--;
					await this.yieldToEventLoop();
					continue;
				}

				const readyForPrep = await this.fileStateService.getAll('20_validated');
				if (readyForPrep.length > 0) {
					const objectId = readyForPrep[0];
					await this.ensureJob(objectId);
					await this.fileStateService.move('20_validated', '30_preparing', objectId);
					this._runPreparation(objectId);
					availableLightSlots--;
					await this.yieldToEventLoop();
					continue;
				}

				const queued = await this.fileStateService.getAll('00_queued');
				await this.fileStateService.addAll('all', queued);
					if (queued.length > 0) {
						const objectId = queued[0];
						await this.ensureJob(objectId);
						await this.fileStateService.move('00_queued', '10_validating', objectId);
						this._runValidation(objectId);
						availableLightSlots--;
						await this.yieldToEventLoop();
						continue;
					}
					
					break; // No more light tasks to start
				}
		} finally {
			this.isProcessing = false;
			// this.logger.info(`_processQueue: set isProcessing to false.`);
		}
	}

	private async _runErrorHandler(objectId: string, error: Error, fromState: string) {
		if (error.name === 'AbortError') {
			this.logger.info(`Download for object ${objectId} was aborted.`);
			// cancelDownload handles moving to 'cancelled' state.
		} else {
			this.logger.error(`Failed to download object ${objectId}: ${error.message}`);
			
			let failureState = 'failure_unknown';
			if (error instanceof AuthenticationError) {
				failureState = 'failure_auth';
				this.handleAuthError();
			} else if (error instanceof HttpError) {
				failureState = `failure_code_${error.status}`;
			}
	
			if (failureState === 'failure_unknown') {
				await this.fileStateService.addUnknownFailure(objectId, error);
				// Ensure we free up the current state slot even for unknown errors
				await this.fileStateService.move(fromState, 'failure_unknown', objectId);
			} else {
				await this.fileStateService.move(fromState, failureState, objectId);
			}
	
			if (await this.downloadManager.getJob(objectId)) {
				await this.downloadManager.updateJob(objectId, 'failed', 100, "Failed", error.message);
			}
		}
	}

	private async _runValidation(objectId: string): Promise<void> {
		const abortController = new AbortController();
		this.cancellationTokens.set(objectId, abortController);
		try {
			await this.downloadManager.updateJob(objectId, '10_validating', 5, 'Validating...');
			this.logger.info(`(model ${objectId}) State updated to 'validating'`);
			const validationResult = await this.validationService.validateAndGetResult(objectId);
	
			if (validationResult) {
				if (validationResult.isValid) {
					await this.downloadManager.updateJob(objectId, '80_completed', 100, 'Model already downloaded and valid');
					await this.fileStateService.move('10_validating', '80_completed', objectId);
					this.logger.info(`(model ${objectId}) State updated to 'complete'`);
				} else {
					this.logger.info(`Validation failed for object ${objectId}. Deleting folder and re-downloading. Errors: ${validationResult.errors.join(', ')}`);
					await this.validationService.deleteObjectFolder(validationResult.folderPath);
					await this.fileStateService.move('10_validating', '20_validated', objectId); // Ready for prep
					this.logger.info(`(model ${objectId}) State updated to 'validated' (but failed validation)`);
				}
			} else {
				await this.fileStateService.move('10_validating', '20_validated', objectId); // Ready for prep
				this.logger.info(`(model ${objectId}) State updated to 'validated' (but failed validation)`);
			}
		} catch (error) {
			await this._runErrorHandler(objectId, error, '10_validating');
		} finally {
			this.cancellationTokens.delete(objectId);
			this._processQueue();
		}
	}
	
	private async _runPreparation(objectId: string): Promise<void> {
		const abortController = new AbortController();
		this.cancellationTokens.set(objectId, abortController);
		try {
			await this.downloadManager.updateJob(objectId, '30_preparing', 10, 'Preparing metadata...');
			
			let object: MMFObject;
			try {
				this.logger.info(`Attempting to retrieve object ${objectId}`);
				object = await this.apiService.getObjectById(objectId);
				if (abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError');
			} catch (objectError) {
				// ... (error handling for object retrieval)
				throw objectError;
			}
			
			const job = await this.downloadManager.getJob(objectId);
			if (object && job) {
				await this.downloadManager.updateJobObject(job.id, object);
			} else if (!job) {
				throw new Error(`Job not found for object ID ${objectId}`);
			}
			
			await this.downloadManager.updateJob(objectId, '30_preparing', 20, "Creating folders...");
			const objectFolder = await this.createObjectFolder(object);
			// Persist real metadata early so later steps (and retries) know the correct folder/name
			await this.saveMetadataFile(object, objectFolder);
			if (abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError');
			
			// now ready for image download
			await this.fileStateService.move('30_preparing', '40_prepared', objectId);
	
		} catch (error) {
			await this._runErrorHandler(objectId, error, '30_preparing');
		} finally {
			this.cancellationTokens.delete(objectId);
			this._processQueue();
		}
	}
	
	private async _runImageDownload(objectId: string): Promise<void> {
		const abortController = new AbortController();
		this.cancellationTokens.set(objectId, abortController);
		try {
			const job = await this.downloadManager.getJob(objectId);
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
			this.cancellationTokens.delete(objectId);
			this._processQueue();
		}
	}
	
	private async _runFileDownload(objectId: string): Promise<void> {
		const abortController = new AbortController();
		this.cancellationTokens.set(objectId, abortController);
		try {
			const job = await this.downloadManager.getJob(objectId);
			if (!job) throw new Error(`Job not found for object ID ${objectId}`);
	
			await this.downloadManager.updateJob(objectId, '70_downloading', 70, 'Downloading files...');
	
			const objectFolder = await this.createObjectFolder(job.object);
	
			if (this.settings.downloadFiles) {
				await this.fileDownloadService.downloadFiles(job, job.object, objectFolder, abortController.signal);
			}

			// Create metadata files at the very end
			await this.downloadManager.updateJob(job.id, '70_downloading', 90, "Creating metadata files...");
			
			let mainLocalImagePath: string | undefined;
			const imagesPath = normalizePath(`${objectFolder}/images`);
			if (await this.folderExists(imagesPath)) {
				const imageFiles = (await this.app.vault.adapter.list(imagesPath)).files;
				if (imageFiles.length > 0) {
					mainLocalImagePath = imageFiles[0];
				}
			}
			
			await this.createMetadataFile(job.object, objectFolder, mainLocalImagePath);
			await this.saveMetadataFile(job.object, objectFolder);

			await this.downloadManager.updateJob(objectId, '80_completed', 100, 'Completed');
			await this.fileStateService.move('70_downloading', '80_completed', objectId);
	
		} catch (error) {
			// Create emergency instructions file on file download failure
			try {
				const job = await this.downloadManager.getJob(objectId);
				if(job) {
					const objectFolder = await this.createObjectFolder(job.object);
					await this.createEmergencyInstructions(objectId, job.object, objectFolder, error);
				}
			} catch (instructionsError) {
				this.logger.error(`Failed to create instructions file: ${instructionsError.message}`);
			}
			await this._runErrorHandler(objectId, error, '70_downloading');
	
		} finally {
			this.cancellationTokens.delete(objectId);
			this._processQueue();
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
		if (!await this.folderExists(filesPath)) {
			await this.app.vault.createFolder(filesPath);
		}

		// Ensure we have a web URL for manual downloads
		const webUrl = object.url || `https://www.myminifactory.com/object/${objectId}`;

		const instructionsPath = normalizePath(`${filesPath}/MANUAL_DOWNLOAD_REQUIRED.md`);
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

		if (!await this.fileExists(instructionsPath)) {
			await this.app.vault.create(instructionsPath, instructionsContent);
		}
		this.logger.info("Created emergency download instructions file");
	}

	private async createObjectFolder(object: MMFObject): Promise<string> {
		// Create base download folder if it doesn't exist
		const basePath = normalizePath(this.settings.downloadPath);
		if (!await this.folderExists(basePath)) {
			await this.app.vault.createFolder(basePath);
		}

		const designerName = object.designer ? this.sanitizePath(object.designer.name) : "Unknown";

		// Create designer folder
		const designerPath = normalizePath(`${basePath}/${designerName}`);
		if (!await this.folderExists(designerPath)) {
			await this.app.vault.createFolder(designerPath);
		}

		// Create object folder
		const objectPath = normalizePath(`${designerPath}/${this.sanitizePath(object.name)}`);
		if (!await this.folderExists(objectPath)) {
			await this.app.vault.createFolder(objectPath);
		}

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
				content += `![Main Image](${this.getImageUrl(mainImage) || ""})\n\n`;
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
				content += `- ${file.filename} (${this.formatFileSize(file.size)})\n`;
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

	// Helper methods
	private getImageUrl(image: any): string | undefined {
		if (typeof image === 'string' && image.startsWith('http')) {
			return image;
		}
		if (!image || typeof image !== 'object') {
			return undefined;
		}
		if (image.large && image.large.url) return image.large.url;
		if (image.standard && image.standard.url) return image.standard.url;
		if (image.original && image.original.url) return image.original.url;
		if (image.thumbnail && image.thumbnail.url) return image.thumbnail.url;
		if (image.tiny && image.tiny.url) return image.tiny.url;
		if (typeof image.url === 'string' && image.url.startsWith('http')) return image.url;
		return undefined;
	}

	private async folderExists(path: string): Promise<boolean> {
		try {
			const folder = this.app.vault.getAbstractFileByPath(path);
			return folder instanceof TFolder;
		} catch (error) {
			return false;
		}
	}

	private async fileExists(path: string): Promise<boolean> {
		try {
			const file = this.app.vault.getAbstractFileByPath(path);
			return file instanceof TFile;
		} catch (error) {
			return false;
		}
	}

	private sanitizePath(path: string): string {
		// Replace illegal characters and ensure no trailing dots/spaces which are disallowed on some filesystems
		return path.replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/, '').trim();
	}

	private formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	}
}
