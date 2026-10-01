import { App, Notice, normalizePath, requestUrl } from 'obsidian';
import { MMFObject } from '../../models/MMFObject';
import { MiniManagerSettings } from '../../settings/MiniManagerSettings';
import { DownloadJob, DownloadManager } from '../DownloadManager';
import { LoggerService } from '../LoggerService';
import { OAuth2Service } from '../OAuth2Service';
import { AuthenticationError, HttpError } from '../../models/Errors';
import { createZipWorker } from '../../workers/factories';
import { formatFileSize } from '../../utils/format';
import { abortError, ensureFolder, fileExists } from '../../utils/vault';

export class FileDownloadService {
	private app: App;
	private settings: MiniManagerSettings;
	private logger: LoggerService;
	private downloadManager: DownloadManager;
	private oauth2Service: OAuth2Service;

	constructor(
		app: App,
		settings: MiniManagerSettings,
		logger: LoggerService,
		downloadManager: DownloadManager,
		oauth2Service: OAuth2Service
	) {
		this.app = app;
		this.settings = settings;
		this.logger = logger;
		this.downloadManager = downloadManager;
		this.oauth2Service = oauth2Service;
	}

	/**
	 * Downloads an object's files. Rejects with an AuthenticationError when the user needs
	 * to log in again, or an HttpError carrying the status when the server refuses a file.
	 */
	public async downloadFiles(job: DownloadJob, object: MMFObject, folderPath: string, signal: AbortSignal): Promise<void> {
		const filesPath = normalizePath(`${folderPath}/files`);
		await ensureFolder(this.app, filesPath);

		if (!object.files || !object.files.items) {
			return;
		}

		const totalFiles = object.files.items.length;
		let downloadedFiles = 0;

		for (const item of object.files.items) {
			if (signal.aborted) throw abortError();
			if (!item.download_url) {
				this.logger.error(`No download URL for file: ${item.filename}`);
				continue;
			}

			if (this.settings.useDirectDownload) {
				try {
					const maxFileSize = 1.5 * 1024 * 1024 * 1024;
					if (item.size && item.size > maxFileSize) {
						throw new Error(`File is too large for direct download (${formatFileSize(item.size)}). Please download it manually.`);
					}

					await this.downloadManager.updateJob(job.id, '70_downloading', 60 + Math.round((downloadedFiles / totalFiles) * 20), `Downloading file ${downloadedFiles + 1}/${totalFiles}`);
					const filePath = normalizePath(`${filesPath}/${item.filename}`);
					if (fileExists(this.app, filePath)) {
						this.logger.info(`Skipping download of file ${filePath}: already exists.`);
						downloadedFiles++;
						continue;
					}

					const accessToken = await this.oauth2Service.getAccessToken();
					const url = `${item.download_url}${item.download_url.includes('?') ? '&' : '?'}access_token=${accessToken}`;

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
						await this.oauth2Service.invalidateToken(accessToken);
						throw new AuthenticationError(`Not authorized to download file: ${item.filename}`);
					}

					if (response.status !== 200) {
						throw new HttpError(`Failed to download file: ${item.filename} (Status ${response.status})`, response.status);
					}

					const contentType = response.headers['content-type'];
					if (contentType && contentType.includes('text/html')) {
						throw new AuthenticationError(`Received a web page instead of ${item.filename}. This is usually a login redirect.`);
					}

					const arrayBuffer = response.arrayBuffer;
					await this.app.vault.createBinary(filePath, arrayBuffer);

					downloadedFiles++;

					if (item.filename.toLowerCase().endsWith('.zip')) {
						await this.downloadManager.updateJob(job.id, 'extracting', 80, `Extracting ${item.filename}`);
						try {
							const zipData = await this.app.vault.adapter.readBinary(filePath);
							await this.extractZipFile(zipData, filesPath, signal);
						} catch (zipError: any) {
							if (zipError.name === 'AbortError') throw zipError;
							this.logger.error(`Error extracting zip file ${item.filename}: ${zipError.message}`);
							throw zipError;
						}
					}
				} catch (error: any) {
					if (error.name === 'AbortError') throw error;
					new Notice(`Error downloading ${item.filename}: ${error.message}`);
					this.logger.error(`Error downloading file ${item.filename}: ${error.message}`);
					throw error;
				}
			} else {
				this.logger.info(`Skipping direct download for file ${item.filename}`);
			}
		}
	}

	private async extractZipFile(zipData: ArrayBuffer, destinationPath: string, signal: AbortSignal): Promise<void> {
		const worker = createZipWorker();

		const run = (): Promise<void> => {
			return new Promise((resolve, reject) => {
				const abortListener = () => {
					worker.terminate();
					reject(abortError());
				};

				signal.addEventListener('abort', abortListener, { once: true });

				worker.onmessage = async (event: MessageEvent<{ entries: { filename: string; content: ArrayBuffer }[]; error?: string }>) => {
					signal.removeEventListener('abort', abortListener);
					worker.terminate();

					if (event.data.error) {
						reject(new Error(event.data.error));
						return;
					}

					try {
						for (const entry of event.data.entries) {
							if (signal.aborted) throw abortError();
							const filePath = normalizePath(`${destinationPath}/${entry.filename}`);
							const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
							if (parentDir) {
								await ensureFolder(this.app, parentDir);
							}
							if (signal.aborted) throw abortError();

							if (fileExists(this.app, filePath)) {
								this.logger.info(`File ${filePath} already exists, skipping extraction.`);
								continue;
							}
							await this.app.vault.createBinary(filePath, entry.content);
						}
						resolve();
					} catch (err) {
						reject(err);
					}
				};

				worker.onerror = (err: ErrorEvent) => {
					signal.removeEventListener('abort', abortListener);
					worker.terminate();
					reject(err);
				};

				try {
					worker.postMessage({ zipData }, [zipData]);
				} catch (err) {
					signal.removeEventListener('abort', abortListener);
					worker.terminate();
					reject(err);
				}
			});
		};

		try {
			await run();
		} catch (error: any) {
			if (error.name === 'AbortError') throw error;
			new Notice(`Failed to extract zip file: ${error.message}`);
			this.logger.error(`Failed to extract zip file: ${error.message}`);
		}
	}
}
