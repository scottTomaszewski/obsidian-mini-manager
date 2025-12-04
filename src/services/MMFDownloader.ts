import { App, Notice, TFile, TFolder, normalizePath, requestUrl, stringifyYaml, Platform } from "obsidian";
import { MiniManagerSettings } from "../settings/MiniManagerSettings";
import { MMFApiService } from "./MMFApiService";
import { MMFObject } from "../models/MMFObject";
import * as JSZip from "jszip";
import { DownloadManager, DownloadJob } from "./DownloadManager";
import { LoggerService } from "./LoggerService";
import { OAuth2Service } from "./OAuth2Service";
import { ValidationService } from "./ValidationService";

export class MMFDownloader {
	private app: App;
	private settings: MiniManagerSettings;
	private apiService: MMFApiService;
	private downloadManager: DownloadManager;
	private logger: LoggerService;
	private oauth2Service: OAuth2Service;
	private validationService: ValidationService;
	private downloadQueue: string[] = [];
	private activeDownloads: number = 0;
	private cancellationTokens: Map<string, AbortController> = new Map(); // For actual request cancellation
	private isPaused: boolean = false;

	constructor(app: App, settings: MiniManagerSettings, logger: LoggerService, oauth2Service: OAuth2Service, validationService: ValidationService) {
		this.app = app;
		this.settings = settings;
		this.logger = logger;
		this.oauth2Service = oauth2Service;
		this.validationService = validationService;
		this.apiService = new MMFApiService(settings, logger, oauth2Service);
		this.downloadManager = DownloadManager.getInstance();
	}

	public resumeDownloads(): void {
		if (this.isPaused) {
			this.isPaused = false;
			new Notice('Resuming downloads...');
			this._processQueue();
		} else {
			new Notice('Downloads are not paused.');
		}
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
		if (this.isPaused) {
			new Notice('Downloads are paused. Please re-authenticate and resume.');
			return;
		}
		const tempObject: MMFObject = {
			id: objectId,
			name: `Validating Object ${objectId}`,
			description: '',
			url: '',
			images: [],
			files: {
				total_count: 0,
				items: []
			}
		};

		const job = this.downloadManager.addJob(tempObject);
		this.downloadManager.updateJob(job.id, 'downloading', 5, 'Validating...');

		const validationResult = await this.validationService.validateAndGetResult(objectId);

		if (validationResult) {
			if (validationResult.isValid) {
				this.downloadManager.updateJob(job.id, 'completed', 100, 'Model already downloaded and valid');
				new Notice(`Model ${validationResult.object.name} already downloaded and valid.`);
			} else {
				this.logger.info(`Validation failed for object ${objectId}. Deleting folder and re-downloading. Errors: ${validationResult.errors.join(', ')}`);
				await this.validationService.deleteObjectFolder(validationResult.folderPath);
				this.downloadManager.updateJob(job.id, 'pending', 0, 'In queue...');
				this.downloadQueue.push(objectId);
				this._processQueue();
			}
		} else {
			this.downloadManager.updateJob(job.id, 'pending', 0, 'In queue...');
			this.downloadQueue.push(objectId);
			this._processQueue();
		}
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
				if (existingJob.status === 'completed') {
					this.logger.info(`Skipping already completed job ${id}`);
					continue;
				} else if (existingJob.status === 'failed') {
					this.logger.info(`Retrying failed job ${id}`);
					this.downloadManager.removeJob(id);
				} else {
					this.logger.info(`Skipping already queued job ${id}`);
					continue;
				}
			}
			await this.downloadObject(id);
		}
	}

	public cancelDownload(objectId: string): void {
		this.downloadQueue = this.downloadQueue.filter(id => id !== objectId); // Remove from queue

		// Abort active HTTP requests if any
		const abortController = this.cancellationTokens.get(objectId);
		if (abortController) {
			abortController.abort();
			this.cancellationTokens.delete(objectId);
		}

		this.downloadManager.removeJob(objectId);
		new Notice(`Download for ${objectId} cancelled.`);
		this.logger.info(`Download for object ${objectId} cancelled.`);
	}

	private async _processQueue(): Promise<void> {
		if (this.isPaused) {
			return;
		}
		if (this.activeDownloads >= this.settings.maxConcurrentDownloads) {
			return;
		}

		if (this.downloadQueue.length === 0) {
			return;
		}

		this.activeDownloads++;
		const objectId = this.downloadQueue.shift();

		// Check if the job was cancelled while in queue
		if (!this.downloadManager.getJob(objectId)) {
			this.logger.info(`Skipping cancelled job ${objectId} from queue.`);
			this.activeDownloads--;
			return this._processQueue(); // Process next in queue
		}

		const abortController = new AbortController();
		this.cancellationTokens.set(objectId, abortController);

		try {
			await this._downloadObjectInternal(objectId, abortController.signal);
		} catch (error) {
			if (error.name === 'AbortError') {
				this.logger.info(`Download for object ${objectId} was aborted.`);
				this.downloadManager.removeJob(objectId); // Ensure it's removed
			} else {
				this.logger.error(`Failed to download object ${objectId} in queue: ${error.message}`);
				// Ensure job status is failed if an unexpected error occurs
				if (this.downloadManager.getJob(objectId)) {
					this.downloadManager.updateJob(objectId, 'failed', 100, "Failed", error.message);
				}
			}
		} finally {
			this.cancellationTokens.delete(objectId);
			this.activeDownloads--;
			this._processQueue();
		}
	}

	private async _downloadObjectInternal(objectId: string, signal: AbortSignal): Promise<void> {
		let object: MMFObject;
		try {
			this.logger.info(`Attempting to retrieve object ${objectId}`);
			object = await this.apiService.getObjectById(objectId);
			if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); // Check for abortion after API call
		} catch (objectError) {
			if (objectError.name === 'AbortError') {
				throw objectError;
			}
			this.logger.error(`Failed to retrieve object ${objectId}: ${objectError.message}`);
			object = {
				id: objectId,
				name: `MyMiniFactory Object ${objectId}`,
				description: "Unable to retrieve details from the API. This could be due to API changes, authentication issues, or the object may not exist.",
				url: `https://www.myminifactory.com/object/${objectId}`,
				images: [],
				files: {
					total_count: 0,
					items: []
				}
			};
			throw objectError;
		}

		const job = this.downloadManager.getJob(objectId) || this.downloadManager.addJob(object);
		if (object) {
			this.downloadManager.updateJobObject(job.id, object);
		}

		try {
			this.downloadManager.updateJob(job.id, 'downloading', 10, "Starting download...");
			this.logger.info(`Starting download for object ID: ${objectId}`);

			// Track what was successfully downloaded
			let objectDetailsRetrieved = object.description !== "Unable to retrieve details from the API. This could be due to API changes, authentication issues, or the object may not exist.";
			let imagesDownloaded = false;
			let filesDownloaded = false;
			let errorMessages = [];

			this.downloadManager.updateJob(job.id, 'downloading', 20, "Creating folders...");
			if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

			// Create folder structure - even with minimal object
			const objectFolder = await this.createObjectFolder(object);
			if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

			let mainLocalImagePath: string | undefined;

			// Download images if enabled and we have object details
			if (this.settings.downloadImages && objectDetailsRetrieved) {
				try {
					this.logger.info("Attempting to download images...");
					this.downloadManager.updateJob(job.id, 'downloading', 50, "Downloading images...");
					mainLocalImagePath = await this.downloadImages(job, object, objectFolder, signal); // Pass signal
					imagesDownloaded = true;
				} catch (imageError) {
					if (imageError.name === 'AbortError') throw imageError;
					this.logger.error(`Error downloading images: ${imageError.message}`);
					errorMessages.push(`Images download error: ${imageError.message}`);
				}
			}
			if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

			this.downloadManager.updateJob(job.id, 'downloading', 30, "Creating metadata files...");
			// Create metadata markdown file with what we have
			await this.createMetadataFile(object, objectFolder, mainLocalImagePath);
			await this.saveMetadataFile(object, objectFolder);
			if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

			this.downloadManager.updateJob(job.id, 'downloading', 40, "Checking API details...");
			// If we couldn't even get object details and strict mode is on, stop here
			if (!objectDetailsRetrieved && this.settings.strictApiMode) {
				throw new Error(`Failed to retrieve object details for ID ${objectId}`);
			}
			if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

			this.downloadManager.updateJob(job.id, 'downloading', 60, "Downloading files...");
			// Download files if enabled
			if (this.settings.downloadFiles) {
				try {
					this.logger.info("Attempting to download 3D model files...");

					// First check if the object already contains file URLs
					let objectWithFiles = object;

					// Make sure we have a web URL for manual downloads
					if (!objectWithFiles.url) {
						const slug = objectWithFiles.name
							? encodeURIComponent(objectWithFiles.name.toLowerCase().replace(/\s+/g, '-'))
							: objectId;
						objectWithFiles.url = `https://www.myminifactory.com/object/${slug}-${objectId}`;
					}

					// Ensure files is an array before proceeding
					if (!objectWithFiles.files || !objectWithFiles.files.items || !Array.isArray(objectWithFiles.files.items)) {
						objectWithFiles.files = {total_count: 0, items: []};
						this.logger.warn("Files property is not an array, initializing as empty array");
					}
					if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

					// Try to download files or at least create instructions
					await this.downloadFiles(job, objectWithFiles, objectFolder, signal); // Pass signal
					filesDownloaded = true;
				} catch (filesError) {
					if (filesError.name === 'AbortError') throw filesError;
					this.logger.error(`Error downloading files: ${filesError.message}`);
					errorMessages.push(`Files download error: ${filesError.message}`);

					// Create fallback download instructions even if everything fails
					try {
						await this.createEmergencyInstructions(objectId, object, objectFolder, filesError);
					} catch (instructionsError) {
						this.logger.error(`Failed to create instructions file: ${instructionsError.message}`);
					}
				}
			}
			if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
			this.downloadManager.updateJob(job.id, 'downloading', 80, "Finalizing...");

			// Prepare completion message
			let status = "";
			if (objectDetailsRetrieved) {
				status = "details";
				if (imagesDownloaded) status += " + images";
				if (filesDownloaded) status += " + files";
			} else {
				status = "minimal info only";
			}

			let message = `Processed "${object.name}" (${status})
`;

			if (errorMessages.length > 0) {
				message += " with errors";
				this.logger.warn(`Download completed with errors: ${errorMessages.join(', ')}`);
				this.downloadManager.updateJob(job.id, 'failed', 100, "Completed with errors", errorMessages.join('\n'));
			} else {
				this.downloadManager.updateJob(job.id, 'completed', 100, "Completed");
			}

			new Notice(message);
		} catch (error) {
			if (error.name === 'AbortError') {
				this.downloadManager.removeJob(objectId); // Remove the job if it was aborted
				this.logger.info(`Download for object ${objectId} was aborted in _downloadObjectInternal.`);
				throw error; // Propagate the AbortError
			}
			this.logger.error(`Error downloading object ${objectId}: ${error.message}`);
			this.downloadManager.updateJob(job.id, 'failed', 100, "Failed", error.message);

			// Create a minimal placeholder and instructions if possible
			try {
				const baseFolder = normalizePath(this.settings.downloadPath);
				const objectFolder = normalizePath(`${baseFolder}/object_${objectId}`);

				// Create the folder structure if it doesn't exist
				if (!await this.folderExists(baseFolder)) {
					await this.app.vault.createFolder(baseFolder);
				}

				if (!await this.folderExists(objectFolder)) {
					await this.app.vault.createFolder(objectFolder);
				}

				// Create emergency instructions
				const instructionsPath = normalizePath(`${objectFolder}/API_ERROR.md`);
				if (!await this.fileExists(instructionsPath)) {
					let content = `# MyMiniFactory API Error\n\n`;
					content += `## Error Details\n\n`;
					content += `Failed to download object ID: ${objectId}\n\n`;
					content += `Error: ${error.message}\n\n`;
					content += `Time: ${new Date().toLocaleString()}\n\n`;
					content += `## Possible Solutions\n\n`;
					content += `1. **Check your API key** in the plugin settings\n`;
					content += `2. **Verify the object ID** is correct: ${objectId}\n`;
					content += `3. **Try again later** as this might be a temporary API issue\n`;
					content += `4. **Visit the object directly** on MyMiniFactory: [Object ${objectId}](https://www.myminifactory.com/object/${objectId})\n`;
					content += `5. **Check for plugin updates** as the API might have changed\n\n`;
					content += `## Manual Download\n\n`;
					content += `If the API continues to fail, you can manually download the object:\n\n`;
					content += `1. Visit [MyMiniFactory](https://www.myminifactory.com)\n`;
					content += `2. Search for the object ID: ${objectId}\n`;
					content += `3. Download the files manually\n`;
					content += `4. Place them in the files subfolder of this directory\n`;

					await this.app.vault.create(instructionsPath, content);
				}
			} catch (emergencyError) {
				this.logger.error(`Failed to create emergency instructions: ${emergencyError.message}`);
			}

			throw new Error(`Failed to download object: ${error.message}`);
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
		content += `4. Place them in the files subfolder of this directory\n`;

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

	/**
	 * Safely extract file extension from URL or provide a default
	 */
	private getFileExtensionFromUrl(url: string | undefined): string {
		// Return default extension if URL is undefined
		if (!url) {
			this.logger.warn("Image URL is undefined, using default .jpg extension");
			return ".jpg";
		}

		try {
			// Try to extract extension from URL
			const matches = url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
			if (matches && matches.length > 1) {
				return `.${matches[1].toLowerCase()}`;
			}

			// For URLs without extensions or unexpected formats, use a default
			this.logger.warn(`No file extension found in URL: ${url}, using default .jpg extension`);
			return ".jpg";
		} catch (error) {
			this.logger.error(`Error extracting file extension from URL: ${url}, ${error.message}`);
			return ".jpg";
		}
	}

	/**
	 * Extract image URL from MyMiniFactory image object based on API response structure
	 */
	private getImageUrl(image: any): string | undefined {
		// If image is already a string URL, return it directly
		if (typeof image === 'string' && image.startsWith('http')) {
			return image;
		}

		// Make sure we have an object to work with
		if (!image || typeof image !== 'object') {
			return undefined;
		}

		// Handle the complex nested structure from the API
		// Prefer larger image formats when available
		if (image.large && image.large.url) {
			return image.large.url;
		} else if (image.standard && image.standard.url) {
			return image.standard.url;
		} else if (image.original && image.original.url) {
			return image.original.url;
		} else if (image.thumbnail && image.thumbnail.url) {
			return image.thumbnail.url;
		} else if (image.tiny && image.tiny.url) {
			return image.tiny.url;
		}

		// Handle direct URL in url property
		if (typeof image.url === 'string' && image.url.startsWith('http')) {
			return image.url;
		}

		// No URL found
		return undefined;
	}


	private async downloadImages(job: DownloadJob, object: MMFObject, folderPath: string, signal: AbortSignal): Promise<string | undefined> {
		this.logger.info(`Processing object for images: ${object.id} ${object.name}`);

		// Create images folder
		const imagesPath = normalizePath(`${folderPath}/images`);
		if (!await this.folderExists(imagesPath)) {
			await this.app.vault.createFolder(imagesPath);
		}

		let mainLocalImagePath: string | undefined;

		// Check if images array exists and handle it
		if (object.images && object.images.length > 0) {
			// The API returns images as an array of complex objects
			const imageArray = Array.isArray(object.images) ? object.images : [object.images];

			this.logger.info(`Found ${imageArray.length} images in the object`);

			if (imageArray.length === 0) {
				this.logger.info(`Empty images array for object ${object.id}`);
			} else {
				// Download each image
				for (let i = 0; i < imageArray.length; i++) {
					if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
					const image = imageArray[i];
					this.logger.info(`Processing image ${i + 1}/${imageArray.length}`);
					this.downloadManager.updateJob(job.id, 'downloading', 50 + Math.round(((i + 1) / imageArray.length) * 10), `Downloading image ${i + 1}/${imageArray.length}`);

					const imageUrl = this.getImageUrl(image);

					if (!imageUrl) {
						this.logger.warn(`Could not determine URL for image ${i + 1}`);
						continue;
					}

					const downloadedPath = await this.downloadSingleImage(imageUrl, imagesPath, `image_${i + 1}`, signal);
					if (downloadedPath && !mainLocalImagePath) {
						mainLocalImagePath = downloadedPath;
					}
				}
			}
		} else {
			this.logger.info(`No images array found for object ${object.id}`);
		}

		// If we still have no images, create a placeholder
		const files = await this.app.vault.adapter.list(imagesPath);
		if (files && files.files.length === 0) {
			this.logger.info("No images were downloaded, creating placeholder");
			const placeholderPath = normalizePath(`${imagesPath}/no_images.md`);
			const placeholderContent = `# No Images Available\n\nNo images could be downloaded for this object.\n\nPlease visit the original page to view images:\n${object.url}`;
			if (!await this.fileExists(placeholderPath)) {
				await this.app.vault.create(placeholderPath, placeholderContent);
			}
		}

		return mainLocalImagePath;
	}

	/**
	 * Download a single image given its URL
	 */
	private async downloadSingleImage(url: string, folderPath: string, baseFileName: string, signal: AbortSignal): Promise<string | undefined> {
		try {
			const fileName = `${baseFileName}${this.getFileExtensionFromUrl(url)}`;
			const filePath = normalizePath(`${folderPath}/${fileName}`);

			if (await this.fileExists(filePath)) {
				this.logger.info(`Skipping download of image ${filePath}: already exists.`);
				return filePath;
			}

			// new Notice(`Downloading ${baseFileName}...`);
			this.logger.info(`Downloading image from URL: ${url}`);

			const response = await requestUrl({
				url: url,
				method: 'GET',
				headers: {
					'Cache-Control': 'no-cache',
					'Pragma': 'no-cache',
					'Expires': '0',
				},
				signal: signal // Pass signal here
			});

			if (response.status !== 200) {
				throw new Error(`Failed to download image: ${response.status}`);
			}

			const contentType = response.headers['content-type'];
			if (contentType && contentType.includes('text/html')) {
				this.handleAuthError();
				throw new Error('Invalid content type: received text/html. This may be a login redirect.');
			}

			await this.app.vault.createBinary(filePath, response.arrayBuffer);
			this.logger.info(`Successfully downloaded ${baseFileName}`);
			return filePath;
		} catch (error) {
			if (error.name === 'AbortError') throw error; // Re-throw AbortError
			new Notice(`Error downloading ${baseFileName}: ${error.message}`);
			this.logger.error(`Error downloading image ${url}: ${error.message}`);

			// Create a placeholder file with instructions if download fails
			const placeholderPath = normalizePath(`${folderPath}/${baseFileName}_error.md`);
			const placeholderContent = `# Download Error\n\nFailed to download image from: ${url}\n\nError: ${error.message}\n\nPlease visit the MyMiniFactory website to view this image.`;
			if (!await this.fileExists(placeholderPath)) {
				await this.app.vault.create(placeholderPath, placeholderContent);
			}
			return undefined;
		}
	}

	private async downloadFiles(job: DownloadJob, object: MMFObject, folderPath: string, signal: AbortSignal): Promise<void> {
		// Create files folder
		const filesPath = normalizePath(`${folderPath}/files`);
		if (!await this.folderExists(filesPath)) {
			await this.app.vault.createFolder(filesPath);
		}

		if (!object.files || !object.files.items) {
			return;
		}

		const totalFiles = object.files.items.length;
		let downloadedFiles = 0;

		// Download each file
		for (const item of object.files.items) {
			if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
			if (!item.download_url) {
				this.logger.error(`No download URL for file: ${item.filename}`);
				continue;
			}

			// Only attempt direct download if the setting is enabled
			if (this.settings.useDirectDownload) {
				try {
					this.downloadManager.updateJob(job.id, 'downloading', 60 + Math.round((downloadedFiles / totalFiles) * 20), `Downloading file ${downloadedFiles + 1}/${totalFiles}`);
					const filePath = normalizePath(`${filesPath}/${item.filename}`);
					if (await this.fileExists(filePath)) {
						this.logger.info(`Skipping download of file ${filePath}: already exists.`);
						downloadedFiles++;
						continue;
					}

					const accessToken = await this.oauth2Service.getAccessToken();
					const headers: Record<string, string> = {
						'Cache-Control': 'no-cache',
						'Pragma': 'no-cache',
						'Expires': '0',
					};

					let url = item.download_url;
					if (accessToken) {
						url += `${url.includes('?') ? '&' : '?'}access_token=${accessToken}`;
					}

					const response = await requestUrl({
						url: url,
						method: 'GET',
						headers: headers,
						signal: signal // Pass signal here
					});

					if (response.status !== 200) {
						throw new Error(`Failed to download file: ${item.filename} (Status ${response.status})`);
					}

					const contentType = response.headers['content-type'];
					if (contentType && contentType.includes('text/html')) {
						this.handleAuthError();
						throw new Error('Invalid content type: received text/html. This may be a login redirect.');
					}

					const arrayBuffer = response.arrayBuffer;
					await this.app.vault.createBinary(filePath, arrayBuffer);
					new Notice(`Successfully downloaded ${item.filename}`);

					downloadedFiles++;

					if (item.filename.toLowerCase().endsWith('.zip')) {
						if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
						new Notice(`Extracting ${item.filename}...`);
						this.downloadManager.updateJob(job.id, 'extracting', 80, `Extracting ${item.filename}`);
						try {
							const zipData = await this.app.vault.adapter.readBinary(filePath);
							await this.extractZipFile(zipData, filesPath, signal); // Pass signal
						} catch (zipError) {
							if (zipError.name === 'AbortError') throw zipError;
							this.logger.error(`Error extracting zip file ${item.filename}: ${zipError.message}`);
							throw zipError; // Re-throw to be caught by the outer catch
						}
					}
				} catch (error) {
					if (error.name === 'AbortError') throw error;
					new Notice(`Error downloading ${item.filename}: ${error.message}`);
					this.logger.error(`Error downloading file ${item.filename}: ${error.message}`);
					throw error; // Re-throw the error to be caught by the caller
				}
			} else {
				this.logger.info(`Skipping direct download for file ${item.filename}`);
			}
		}
	}

	private async extractZipFile(zipData: ArrayBuffer, destinationPath: string, signal: AbortSignal): Promise<void> {
		try {
			const zip = await JSZip.loadAsync(zipData);
			new Notice(`Extracting ${Object.keys(zip.files).length} files...`);

			for (const filename in zip.files) {
				if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
				const file = zip.files[filename];

				if (!file.dir) {
					const content = await file.async('arraybuffer');
					const filePath = normalizePath(`${destinationPath}/${filename}`);

					// Ensure subdirectories exist
					const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
					if (parentDir && !await this.folderExists(parentDir)) {
						await this.app.vault.createFolder(parentDir);
					}
					if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

					if (await this.fileExists(filePath)) {
						this.logger.info(`File ${filePath} already exists, skipping extraction.`);
						continue;
					}
					await this.app.vault.createBinary(filePath, content);
				}
			}
			new Notice('Extraction complete.');
		} catch (error) {
			if (error.name === 'AbortError') throw error;
			new Notice(`Failed to extract zip file: ${error.message}`);
			this.logger.error(`Failed to extract zip file: ${error.message}`);
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
		return path.replace(/[\\/:*?"<>|]/g, '_').trim();
	}

	private formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	}
}
