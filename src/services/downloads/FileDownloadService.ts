import { App, Notice, TFile, TFolder, normalizePath, requestUrl } from 'obsidian';
import { MMFObject } from '../../models/MMFObject';
import { MiniManagerSettings } from '../../settings/MiniManagerSettings';
import { DownloadJob, DownloadManager } from '../DownloadManager';
import { LoggerService } from '../LoggerService';
import { OAuth2Service } from '../OAuth2Service';
import { FileStateService } from '../FileStateService';
import { HttpError } from '../../models/Errors';
import createZipWorker from '../../workers/zip.worker';

export class FileDownloadService {
	private app: App;
	private settings: MiniManagerSettings;
	private logger: LoggerService;
	private downloadManager: DownloadManager;
	private oauth2Service: OAuth2Service;
	private fileStateService: FileStateService;
	private handleAuthError: () => void;
	private pauseFileDownloads: (message?: string) => void;
	private formatFileSize: (bytes: number) => string;
	private onForbidden: (jobId: string) => Promise<void>;

	constructor(
		app: App,
		settings: MiniManagerSettings,
		logger: LoggerService,
		downloadManager: DownloadManager,
		oauth2Service: OAuth2Service,
		fileStateService: FileStateService,
		handleAuthError: () => void,
		pauseFileDownloads: (message?: string) => void,
		formatFileSize: (bytes: number) => string,
		onForbidden: (jobId: string) => Promise<void>
	) {
		this.app = app;
		this.settings = settings;
		this.logger = logger;
		this.downloadManager = downloadManager;
		this.oauth2Service = oauth2Service;
		this.fileStateService = fileStateService;
		this.handleAuthError = handleAuthError;
		this.pauseFileDownloads = pauseFileDownloads;
		this.formatFileSize = formatFileSize;
		this.onForbidden = onForbidden;
	}

	public async downloadFiles(job: DownloadJob, object: MMFObject, folderPath: string, signal: AbortSignal): Promise<void> {
		const filesPath = normalizePath(`${folderPath}/files`);
		if (!await this.folderExists(filesPath)) {
			await this.app.vault.createFolder(filesPath);
		}

		if (!object.files || !object.files.items) {
			return;
		}

		const totalFiles = object.files.items.length;
		let downloadedFiles = 0;

		for (const item of object.files.items) {
			if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
			if (!item.download_url) {
				this.logger.error(`No download URL for file: ${item.filename}`);
				continue;
			}

			if (this.settings.useDirectDownload) {
				try {
					const maxFileSize = 1.5 * 1024 * 1024 * 1024;
					if (item.size && item.size > maxFileSize) {
						throw new Error(`File is too large for direct download (${this.formatFileSize(item.size)}). Please download it manually.`);
					}

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

					if (response.status === 403) {
						this.pauseFileDownloads('Received 403 while downloading files. File downloads paused; resume after resolving authentication.');
						await this.onForbidden(job.id);
						throw new HttpError(`Forbidden downloading file: ${item.filename}`, response.status);
					}

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

					downloadedFiles++;

					if (item.filename.toLowerCase().endsWith('.zip')) {
						if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
						this.downloadManager.updateJob(job.id, 'extracting', 80, `Extracting ${item.filename}`);
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
					reject(new DOMException('Aborted', 'AbortError'));
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
							if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
							const filePath = normalizePath(`${destinationPath}/${entry.filename}`);
							const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
							if (parentDir && !await this.folderExists(parentDir)) {
								await this.app.vault.createFolder(parentDir);
							}
							if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

							if (await this.fileExists(filePath)) {
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

				worker.onerror = (err) => {
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
