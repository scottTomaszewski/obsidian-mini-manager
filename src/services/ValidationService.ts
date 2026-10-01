import { App, DataAdapter, FileSystemAdapter } from 'obsidian';
import { MiniManagerSettings } from '../settings/MiniManagerSettings';
import { MMFObject } from '../models/MMFObject';
import { ACTIVE_STATES, COMPLETED_STATE, FileStateService } from './FileStateService';
import { DownloadManager } from './DownloadManager';
import { createValidationWorker } from '../workers/factories';
import { processValidationPayload } from '../workers/validationWorkerProcessor';
import type { ValidationWorkerInput, ValidationWorkerOutput } from '../workers/validationWorkerTypes';

export interface ValidationResult {
    object: MMFObject;
    folderPath: string;
    isValid: boolean;
    errors: string[];
    /** Placeholder folders for the same object that should simply be deleted. */
    staleFolders?: string[];
}

/** The state of an object whose download was checked and found wanting. */
export const VALIDATION_FAILURE_STATE = 'failure_validation';

export const PLACEHOLDER_ERROR = 'Placeholder only: the object was never fetched from MyMiniFactory.';

/**
 * Whether this is metadata the plugin made up rather than fetched. Older versions saved
 * such a placeholder, and marked the download complete, when the API call failed.
 */
export function isPlaceholderObject(object: MMFObject): boolean {
	return object?.name === `Object ${object?.id}` &&
		(object.images?.length ?? 0) === 0 &&
		(object.files?.items?.length ?? 0) === 0;
}

export class ValidationService {
    private app: App;
    private settings: MiniManagerSettings;
	private fileStateService: FileStateService;
	private downloadManager: DownloadManager;

    constructor(app: App, settings: MiniManagerSettings, fileStateService: FileStateService, downloadManager: DownloadManager) {
        this.app = app;
        this.settings = settings;
		this.fileStateService = fileStateService;
		this.downloadManager = downloadManager;
    }

    public async validate(): Promise<ValidationResult[]> {
        const downloadPath = this.settings.downloadPath;
        const adapter = this.app.vault.adapter;

        if (!await adapter.exists(downloadPath)) {
            return [];
		}

        const designerFolders = await adapter.list(downloadPath);
        const validationTasks: Array<() => Promise<ValidationResult | null>> = [];

		for (const designerFolder of designerFolders.folders) {
			const objectFolders = await adapter.list(designerFolder);

			for (const objectFolder of objectFolders.folders) {
				validationTasks.push(this.createValidationTask(objectFolder, adapter));
			}
		}

		if (validationTasks.length === 0) {
			return [];
		}

        const results = (await this.runWithConcurrency(validationTasks, this.settings.maxConcurrentValidations))
			.filter((r): r is ValidationResult => r !== null);
		await this.recordResults(results);
		return results;
    }

	/**
	 * Brings each object's state in line with what is on disk, so that a bad download does
	 * not sit in "completed" where nothing would ever retry it. An object can have more
	 * than one folder (a stale placeholder beside the real download); one valid folder is
	 * enough. Objects that are being downloaded right now are left alone.
	 */
	private async recordResults(results: ValidationResult[]): Promise<void> {
		const errorsById = new Map<string, string[] | null>();
		for (const result of results) {
			const id = String(result.object.id);
			if (result.isValid) {
				errorsById.set(id, null);
			} else if (!errorsById.has(id)) {
				errorsById.set(id, result.errors);
			}
		}

		await this.fileStateService.addAll('all', Array.from(errorsById.keys()));
		for (const [id, errors] of errorsById) {
			const state = this.fileStateService.getState(id);
			if (state !== undefined && ACTIVE_STATES.includes(state)) continue;

			if (errors === null) {
				await this.fileStateService.add(COMPLETED_STATE, id);
			} else {
				await this.fileStateService.add(VALIDATION_FAILURE_STATE, id);
				await this.downloadManager.updateJob(id, 'failed', 100, 'Failed validation', errors.join(' '));
			}
		}
	}

	/**
	 * Checks what is on disk for an object. If it has a real download and placeholder
	 * folders as well, the real download is the one judged and the placeholders are
	 * reported as stale.
	 */
	public async validateAndGetResult(objectId: string): Promise<ValidationResult | null> {
		const downloads = await this.findDownloads(objectId);
		if (downloads.length === 0) {
			return null;
		}

		const chosen = downloads.find(download => !isPlaceholderObject(download.object)) ?? downloads[0];
		const result = await this.validateObject(chosen.object, chosen.folderPath);
		result.staleFolders = downloads
			.filter(download => download !== chosen && isPlaceholderObject(download.object))
			.map(download => download.folderPath);
		return result;
	}

	public async deleteObjectFolder(folderPath: string): Promise<void> {
		await this.app.vault.adapter.rmdir(folderPath, true);
	}

    /** Every folder under the download path whose metadata says it holds this object. */
    private async findDownloads(objectId: string): Promise<{ folderPath: string; object: MMFObject }[]> {
        const downloadPath = this.settings.downloadPath;
        const adapter = this.app.vault.adapter;
        const targetId = String(objectId);
        const downloads: { folderPath: string; object: MMFObject }[] = [];

        if (!await adapter.exists(downloadPath)) {
            return downloads;
        }

        const designerFolders = await adapter.list(downloadPath);

        for (const designerFolder of designerFolders.folders) {
            const objectFolders = await adapter.list(designerFolder);

            for (const objectFolder of objectFolders.folders) {
                const metadataPath = `${objectFolder}/mmf-metadata.json`;
                if (await adapter.exists(metadataPath)) {
                    const metadataContent = await adapter.read(metadataPath);
                    const object = JSON.parse(metadataContent) as MMFObject;

                    if (object?.id !== undefined && String(object.id) === targetId) {
                        downloads.push({ folderPath: objectFolder, object });
                    }
                }
            }
        }

        return downloads;
    }

    private async validateObject(object: MMFObject, folderPath: string): Promise<ValidationResult> {
		if (isPlaceholderObject(object)) {
			return { object, folderPath, isValid: false, errors: [PLACEHOLDER_ERROR] };
		}

		const payload = await this.buildValidationPayload(object, folderPath);
		let errors: string[] = [];

		try {
			errors = await this.runValidationInWorker(payload);
		} catch (error) {
			console.error('Validation worker failed; running on main thread instead.', error);
			errors = processValidationPayload(payload);
		}

        return {
            object,
            folderPath,
            isValid: errors.length === 0,
            errors,
        };
    }

	private async buildValidationPayload(object: MMFObject, folderPath: string): Promise<ValidationWorkerInput> {
		const adapter = this.app.vault.adapter;

		const readmePath = `${folderPath}/README.md`;
		const readmeExists = await adapter.exists(readmePath);
		const readmeContent = readmeExists ? await adapter.read(readmePath) : undefined;

		const expectedImages = object.images?.length ?? 0;
		const imagesEnabled = this.settings.downloadImages && expectedImages > 0;
		const imagesPath = `${folderPath}/images`;
		let imagesFound = 0;
		let imagesFolderMissing = true;

		if (imagesEnabled) {
			imagesFolderMissing = !(await adapter.exists(imagesPath));
			if (!imagesFolderMissing) {
				const downloadedImages = await adapter.list(imagesPath);
				// Notes the plugin leaves for images it could not fetch are not images.
				imagesFound = downloadedImages.files.filter(file => !file.toLowerCase().endsWith('.md')).length;
			}
		}

		const filesEnabled = this.settings.downloadFiles && !!(object.files && object.files.items.length > 0);
		const filesPath = `${folderPath}/files`;
		let filesFolderMissing = true;
		const fileChecks: ValidationWorkerInput['files']['items'] = [];

		if (filesEnabled) {
			filesFolderMissing = !(await adapter.exists(filesPath));
			const expectedItems = object.files?.items ?? [];

			if (filesFolderMissing) {
				for (const item of expectedItems) {
					fileChecks.push({ filename: item.filename, exists: false, isHtml: false });
				}
			} else {
				const downloadedFiles = await adapter.list(filesPath);
				for (const item of expectedItems) {
					const expectedFilePath = `${filesPath}/${item.filename}`;
					const exists = downloadedFiles.files.includes(expectedFilePath);
					const isHtml = exists && this.shouldCheckHtml(item.filename) ? await this.isHtmlFile(expectedFilePath) : false;
					fileChecks.push({ filename: item.filename, exists, isHtml });
				}
			}
		}

		return {
			object,
			folderPath,
			readme: {
				exists: readmeExists,
				content: readmeContent,
			},
			images: {
				enabled: imagesEnabled,
				expected: expectedImages,
				found: imagesFound,
				folderMissing: imagesFolderMissing,
			},
			files: {
				enabled: filesEnabled,
				folderMissing: filesFolderMissing,
				items: fileChecks,
			},
		};
	}

	private async runValidationInWorker(payload: ValidationWorkerInput): Promise<string[]> {
		if (typeof Worker === 'undefined') {
			throw new Error('Workers are not supported in this environment.');
		}

		return new Promise((resolve, reject) => {
			let worker: Worker | null = null;
			const cleanup = () => {
				if (worker) {
					worker.terminate();
					worker = null;
				}
			};

			try {
				const started = createValidationWorker();
				worker = started;

				started.onmessage = (event: MessageEvent<ValidationWorkerOutput>) => {
					cleanup();
					resolve(event.data.errors);
				};

				started.onerror = (err) => {
					cleanup();
					reject(err);
				};

				started.postMessage(payload);
			} catch (error) {
				cleanup();
				reject(error);
			}
		});
	}

	private createValidationTask(objectFolder: string, adapter: DataAdapter): () => Promise<ValidationResult | null> {
		return async () => {
			const metadataPath = `${objectFolder}/mmf-metadata.json`;
			if (!await adapter.exists(metadataPath)) {
				return null;
			}

			let object: MMFObject;
			try {
				const metadataContent = await adapter.read(metadataPath);
				object = JSON.parse(metadataContent) as MMFObject;
			} catch (error) {
				console.error(`Failed to load metadata for ${metadataPath}`, error);
				return null;
			}

			return this.validateObject(object, objectFolder);
		};
	}

	private shouldCheckHtml(filename: string): boolean {
		const lower = filename.toLowerCase();
		return lower.endsWith('.zip') || lower.endsWith('.html');
	}

	private async runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
		const results: T[] = new Array(tasks.length);
		let nextIndex = 0;

		const worker = async () => {
			while (true) {
				const currentIndex = nextIndex++;
				if (currentIndex >= tasks.length) break;
				try {
					results[currentIndex] = await tasks[currentIndex]();
				} catch (error) {
					console.error('Validation task failed', error);
					// @ts-expect-error allow holes/nulls; filtered by caller
					results[currentIndex] = null;
				}
			}
		};

		const runners = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
		await Promise.all(runners);
		return results;
	}

	private async isHtmlFile(filePath: string): Promise<boolean> {
		const adapter = this.app.vault.adapter;
		try {
			if (adapter instanceof FileSystemAdapter) {
				// Desktop: read just the head of the file rather than the whole thing.
				const fs = require('fs');
				const fullPath = adapter.getFullPath(filePath);
				return new Promise((resolve) => {
					const stream = fs.createReadStream(fullPath, { start: 0, end: 511 });
					let data = '';
					stream.on('data', (chunk: Buffer) => {
						data += chunk.toString('utf-8');
					});
					stream.on('end', () => {
						const trimmedContent = data.trimLeft().toLowerCase();
						resolve(
							trimmedContent.startsWith('<!doctype html') ||
							trimmedContent.startsWith('<html') ||
							trimmedContent.startsWith('<head') ||
							trimmedContent.startsWith('<body') ||
							trimmedContent == ''
						);
					});
					stream.on('error', (err: Error) => {
						console.error(`Error reading file for HTML check: ${filePath}`, err);
						resolve(false);
					});
				});

			} else {
				// On mobile, avoid reading huge files. HTML redirects should be small.
				const fileStat = await adapter.stat(filePath);
				if (fileStat && fileStat.size > 1024 * 1024) { // 1MB limit on mobile
					return false; // Assume large files are not HTML
				}
				const content = await adapter.read(filePath);
				const trimmedContent = content.trimLeft().toLowerCase();
				return trimmedContent.startsWith('<!doctype html') ||
					trimmedContent.startsWith('<html') ||
					trimmedContent.startsWith('<head') ||
					trimmedContent.startsWith('<body') ||
					trimmedContent == '';
			}
		} catch (error) {
			console.error(`Error reading file for HTML check: ${filePath}`, error);
			return false;
		}
	}
}
