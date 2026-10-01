import {App, Notice, normalizePath, requestUrl} from 'obsidian';
import {MMFObject} from '../../models/MMFObject';
import {DownloadJob, DownloadManager} from '../DownloadManager';
import {LoggerService} from '../LoggerService';
import {AuthenticationError, HttpError} from '../../models/Errors';
import {abortError, ensureFolder, fileExists} from '../../utils/vault';

export class ImageDownloadService {
	private app: App;
	private logger: LoggerService;
	private downloadManager: DownloadManager;

	constructor(app: App, logger: LoggerService, downloadManager: DownloadManager) {
		this.app = app;
		this.logger = logger;
		this.downloadManager = downloadManager;
	}

	/**
	 * Downloads an object's images. Rejects with an AuthenticationError when the user needs
	 * to log in again, or an HttpError carrying the status when the server refuses an image.
	 */
	public async downloadImages(job: DownloadJob, object: MMFObject, folderPath: string, signal: AbortSignal): Promise<string | undefined> {
		this.logger.info(`Processing object for images: ${object.id} ${object.name}`);

		const imagesPath = normalizePath(`${folderPath}/images`);
		await ensureFolder(this.app, imagesPath);

		let mainLocalImagePath: string | undefined;

		const imageArray = object.images && object.images.length > 0
			? (Array.isArray(object.images) ? object.images : [object.images])
			: [];

		if (imageArray.length === 0) {
			this.logger.info(`No images array found for object ${object.id}`);
		} else {
			this.logger.info(`Found ${imageArray.length} images in the object`);
			const images: { url: string; baseFileName: string }[] = [];

			for (let i = 0; i < imageArray.length; i++) {
				const imageUrl = getImageUrl(imageArray[i]);
				if (!imageUrl) {
					this.logger.warn(`Could not determine URL for image ${i + 1}`);
					continue;
				}
				images.push({url: imageUrl, baseFileName: `image_${i + 1}`});
			}

			for (let i = 0; i < images.length; i++) {
				if (signal.aborted) throw abortError();
				await this.downloadManager.updateJob(job.id, '50_downloading_images', 50 + Math.round(((i + 1) / images.length) * 10), `Downloading image ${i + 1}/${images.length}`);
				const downloadedPath = await this.downloadSingleImage(images[i].url, imagesPath, images[i].baseFileName, signal);
				if (downloadedPath && !mainLocalImagePath) {
					mainLocalImagePath = downloadedPath;
				}
			}
		}

		const files = await this.app.vault.adapter.list(imagesPath);
		if (files && files.files.length === 0) {
			this.logger.info("No images were downloaded, creating placeholder");
			const placeholderPath = normalizePath(`${imagesPath}/no_images.md`);
			const placeholderContent = `# No Images Available\n\nNo images could be downloaded for this object.\n\nPlease visit the original page to view images:\n${object.url}`;
			if (!fileExists(this.app, placeholderPath)) {
				await this.app.vault.create(placeholderPath, placeholderContent);
			}
		}

		await this.downloadManager.updateJob(job.id, '50_downloading_images', 60, 'Pending file downloads');

		return mainLocalImagePath;
	}

	private async downloadSingleImage(url: string, folderPath: string, baseFileName: string, signal: AbortSignal): Promise<string | undefined> {
		try {
			const fileName = `${baseFileName}${this.getFileExtensionFromUrl(url)}`;
			const filePath = normalizePath(`${folderPath}/${fileName}`);

			if (fileExists(this.app, filePath)) {
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
				throw: false // Status codes are handled below
			});
			if (signal.aborted) throw abortError();

			if (response.status === 401) {
				throw new AuthenticationError(`Not authorized to download image: ${fileName}`);
			}

			if (response.status !== 200) {
				throw new HttpError(`Failed to download image: ${response.status}`, response.status);
			}

			const contentType = response.headers['content-type'];
			if (contentType && contentType.includes('text/html')) {
				// Images are public, so unlike a file this says nothing about the login.
				throw new Error(`Received a web page instead of ${fileName}.`);
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
			if (!fileExists(this.app, placeholderPath)) {
				await this.app.vault.create(placeholderPath, placeholderContent);
			}
			throw error;
		}
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
}

/** The best available URL for an image as the API describes it. */
export function getImageUrl(image: any): string | undefined {
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
