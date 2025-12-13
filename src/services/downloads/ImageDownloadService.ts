import { App, Notice, TFile, TFolder, normalizePath, requestUrl } from 'obsidian';
import { MMFObject } from '../../models/MMFObject';
import { MiniManagerSettings } from '../../settings/MiniManagerSettings';
import { DownloadJob, DownloadManager } from '../DownloadManager';
import { LoggerService } from '../LoggerService';
import type { ImageDownloadJob, ImageWorkerResponse } from '../../workers/imageWorkerTypes';

export class ImageDownloadService {
	private app: App;
	private settings: MiniManagerSettings;
	private logger: LoggerService;
	private downloadManager: DownloadManager;
	private handleAuthError: () => void;

	constructor(
		app: App,
		settings: MiniManagerSettings,
		logger: LoggerService,
		downloadManager: DownloadManager,
		handleAuthError: () => void
	) {
		this.app = app;
		this.settings = settings;
		this.logger = logger;
		this.downloadManager = downloadManager;
		this.handleAuthError = handleAuthError;
	}

	public async downloadImages(job: DownloadJob, object: MMFObject, folderPath: string, signal: AbortSignal): Promise<string | undefined> {
		this.logger.info(`Processing object for images: ${object.id} ${object.name}`);

		const imagesPath = normalizePath(`${folderPath}/images`);
		if (!await this.folderExists(imagesPath)) {
			await this.app.vault.createFolder(imagesPath);
		}

		let mainLocalImagePath: string | undefined;

		const imageArray = object.images && object.images.length > 0
			? (Array.isArray(object.images) ? object.images : [object.images])
			: [];

		if (imageArray.length === 0) {
			this.logger.info(`No images array found for object ${object.id}`);
		} else {
			this.logger.info(`Found ${imageArray.length} images in the object`);
			const jobs: ImageDownloadJob[] = [];

			for (let i = 0; i < imageArray.length; i++) {
				const imageUrl = this.getImageUrl(imageArray[i]);
				if (!imageUrl) {
					this.logger.warn(`Could not determine URL for image ${i + 1}`);
					continue;
				}
				const filename = `image_${i + 1}${this.getFileExtensionFromUrl(imageUrl)}`;
				jobs.push({ url: imageUrl, filename });
			}

			if (jobs.length > 0) {
				try {
					const workerResult = await this.fetchImagesWithWorker(jobs, signal);
					let processed = 0;
					for (const file of workerResult.files) {
						if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
						const filePath = normalizePath(`${imagesPath}/${file.filename}`);
						if (await this.fileExists(filePath)) {
							this.logger.info(`Skipping download of image ${filePath}: already exists.`);
						} else {
							await this.app.vault.createBinary(filePath, file.data);
						}
						processed++;
						this.downloadManager.updateJob(job.id, 'downloading', 50 + Math.round((processed / jobs.length) * 10), `Downloading image ${processed}/${jobs.length}`);
						if (!mainLocalImagePath) {
							mainLocalImagePath = filePath;
						}
					}

					if (workerResult.errors.length > 0) {
						workerResult.errors.forEach(err => this.logger.error(err));
					}
				} catch (error) {
					this.logger.warn(`Image worker failed, falling back to main thread downloads: ${error instanceof Error ? error.message : error}`);
					for (let i = 0; i < jobs.length; i++) {
						if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
						const jobItem = jobs[i];
						this.downloadManager.updateJob(job.id, 'downloading', 50 + Math.round(((i + 1) / jobs.length) * 10), `Downloading image ${i + 1}/${jobs.length}`);
						const downloadedPath = await this.downloadSingleImage(jobItem.url, imagesPath, jobItem.filename.replace(/\.[^.]+$/, ''), signal);
						if (downloadedPath && !mainLocalImagePath) {
							mainLocalImagePath = downloadedPath;
						}
					}
				}
			}
		}

		const files = await this.app.vault.adapter.list(imagesPath);
		if (files && files.files.length === 0) {
			this.logger.info("No images were downloaded, creating placeholder");
			const placeholderPath = normalizePath(`${imagesPath}/no_images.md`);
			const placeholderContent = `# No Images Available\n\nNo images could be downloaded for this object.\n\nPlease visit the original page to view images:\n${object.url}`;
			if (!await this.fileExists(placeholderPath)) {
				await this.app.vault.create(placeholderPath, placeholderContent);
			}
		}

		await this.downloadManager.updateJob(job.id, '50_downloading_images', 60, 'Pending file downloads');

		return mainLocalImagePath;
	}

	private async fetchImagesWithWorker(jobs: ImageDownloadJob[], signal: AbortSignal): Promise<ImageWorkerResponse> {
		return new Promise((resolve, reject) => {
			let worker: Worker | null = null;
			const cleanup = () => {
				if (worker) {
					worker.terminate();
					worker = null;
				}
			};

			if (signal.aborted) {
				cleanup();
				reject(new DOMException('Aborted', 'AbortError'));
				return;
			}

			const abortListener = () => {
				cleanup();
				reject(new DOMException('Aborted', 'AbortError'));
			};

			signal.addEventListener('abort', abortListener, { once: true });

			try {
				worker = new Worker(new URL('../../workers/image.worker.ts', import.meta.url), { type: 'module' });
			} catch (error) {
				try {
					worker = new Worker(new URL('../../workers/image.worker.js', import.meta.url), { type: 'module' });
				} catch (fallbackError) {
					signal.removeEventListener('abort', abortListener);
					reject(fallbackError);
					return;
				}
			}

			worker.onmessage = (event: MessageEvent<ImageWorkerResponse>) => {
				signal.removeEventListener('abort', abortListener);
				cleanup();
				resolve(event.data);
			};

			worker.onerror = (err) => {
				signal.removeEventListener('abort', abortListener);
				cleanup();
				reject(err);
			};

			try {
				worker.postMessage({ jobs });
			} catch (error) {
				signal.removeEventListener('abort', abortListener);
				cleanup();
				reject(error);
			}
		});
	}

	private async downloadSingleImage(url: string, folderPath: string, baseFileName: string, signal: AbortSignal): Promise<string | undefined> {
		try {
			const fileName = `${baseFileName}${this.getFileExtensionFromUrl(url)}`;
			const filePath = normalizePath(`${folderPath}/${fileName}`);

			if (await this.fileExists(filePath)) {
				this.logger.info(`Skipping download of image ${filePath}: already exists.`);
				return filePath;
			}

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
		} catch (error: any) {
			if (error.name === 'AbortError') throw error; // Re-throw AbortError
			new Notice(`Error downloading ${baseFileName}: ${error.message}`);
			this.logger.error(`Error downloading image ${url}: ${error.message}`);

			const placeholderPath = normalizePath(`${folderPath}/${baseFileName}_error.md`);
			const placeholderContent = `# Download Error\n\nFailed to download image from: ${url}\n\nError: ${error.message}\n\nPlease visit the MyMiniFactory website to view this image.`;
			if (!await this.fileExists(placeholderPath)) {
				await this.app.vault.create(placeholderPath, placeholderContent);
			}
			throw error;
		}
	}

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

	private getFileExtensionFromUrl(url: string): string {
		try {
			const matches = url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
			if (matches && matches.length > 1) {
				return `.${matches[1].toLowerCase()}`;
			}
			this.logger.warn(`No file extension found in URL: ${url}, using default .jpg extension`);
			return ".jpg";
		} catch (error: any) {
			this.logger.error(`Error extracting file extension from URL: ${url}, ${error.message}`);
			return ".jpg";
		}
	}

	private async folderExists(path: string): Promise<boolean> {
		try {
			const folder = this.app.vault.getAbstractFileByPath(path);
			return folder instanceof TFolder;
		} catch {
			return false;
		}
	}

	private async fileExists(path: string): Promise<boolean> {
		try {
			const file = this.app.vault.getAbstractFileByPath(path);
			return file instanceof TFile;
		} catch {
			return false;
		}
	}
}
