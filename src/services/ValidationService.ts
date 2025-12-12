import { App, Platform } from 'obsidian';
import { MiniManagerSettings } from '../settings/MiniManagerSettings';
import { MMFObject } from '../models/MMFObject';
import { FileStateService } from './FileStateService';
import createValidationWorker from '../workers/validation.worker';
import { processValidationPayload } from '../workers/validationWorkerProcessor';
import type { ValidationWorkerInput, ValidationWorkerOutput } from '../workers/validationWorkerTypes';

export interface ValidationResult {
    object: MMFObject;
    folderPath: string;
    isValid: boolean;
    errors: string[];
}

export class ValidationService {
    private app: App;
    private settings: MiniManagerSettings;
	private fileStateService: FileStateService;

    constructor(app: App, settings: MiniManagerSettings, fileStateService: FileStateService) {
        this.app = app;
        this.settings = settings;
		this.fileStateService = fileStateService;
    }

    public async validate(): Promise<ValidationResult[]> {
        const downloadPath = this.settings.downloadPath;
        const adapter = this.app.vault.adapter;

        if (!await adapter.exists(downloadPath)) {
            return [];
        }

        const designerFolders = await adapter.list(downloadPath);
        const validationPromises: Promise<ValidationResult>[] = [];

        for (const designerFolder of designerFolders.folders) {
            const objectFolders = await adapter.list(designerFolder);

            for (const objectFolder of objectFolders.folders) {
                const metadataPath = `${objectFolder}/mmf-metadata.json`;
                if (await adapter.exists(metadataPath)) {
                    const validationPromise = (async () => {
                        const metadataContent = await adapter.read(metadataPath);
                        const object = JSON.parse(metadataContent) as MMFObject;
                        const result = await this.validateObject(object, objectFolder);
						await this.fileStateService.add('all', object.id);
						if (result.isValid) {
							await this.fileStateService.add('80_completed', object.id);
						}
						return result;
                    })();
                    validationPromises.push(validationPromise);
                }
            }
        }

        return Promise.all(validationPromises);
    }

	public async validateAndGetResult(objectId: string): Promise<ValidationResult | null> {
		const objectFolder = await this.findObjectFolder(objectId);
		if (objectFolder) {
			const metadataPath = `${objectFolder}/mmf-metadata.json`;
			if (await this.app.vault.adapter.exists(metadataPath)) {
				const metadataContent = await this.app.vault.adapter.read(metadataPath);
				const object = JSON.parse(metadataContent) as MMFObject;
				return this.validateObject(object, objectFolder);
			}
		}
		return null;
	}

	public async deleteObjectFolder(folderPath: string): Promise<void> {
		await this.app.vault.adapter.rmdir(folderPath, true);
	}

    private async findObjectFolder(objectId: string): Promise<string | null> {
        const downloadPath = this.settings.downloadPath;
        const adapter = this.app.vault.adapter;
        const targetId = String(objectId);

        if (!await adapter.exists(downloadPath)) {
            return null;
        }

        const designerFolders = await adapter.list(downloadPath);

        for (const designerFolder of designerFolders.folders) {
            const objectFolders = await adapter.list(designerFolder);

            for (const objectFolder of objectFolders.folders) {
                const metadataPath = `${objectFolder}/mmf-metadata.json`;
                if (await adapter.exists(metadataPath)) {
                    const metadataContent = await adapter.read(metadataPath);
                    const object = JSON.parse(metadataContent) as MMFObject;
                    const metadataId = object?.id !== undefined ? String(object.id) : null;
                    const isPlaceholder =
                        typeof object?.name === 'string' &&
                        object.name.trim().toLowerCase().startsWith('object ') &&
                        !object.url &&
                        (!(object.files && 'items' in object.files) || (object.files.items?.length ?? 0) === 0) &&
                        ((object.images?.length ?? 0) === 0);

                    if (metadataId === targetId && !isPlaceholder) {
                        return objectFolder;
                    }
                }
            }
        }

        return null;
    }

    private async validateObject(object: MMFObject, folderPath: string): Promise<ValidationResult> {
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
				imagesFound = downloadedImages.files.length;
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
				worker = createValidationWorker();

				worker.onmessage = (event: MessageEvent<ValidationWorkerOutput>) => {
					cleanup();
					resolve(event.data.errors);
				};

				worker.onerror = (err) => {
					cleanup();
					reject(err);
				};

				worker.postMessage(payload);
			} catch (error) {
				cleanup();
				reject(error);
			}
		});
	}

	private shouldCheckHtml(filename: string): boolean {
		const lower = filename.toLowerCase();
		return lower.endsWith('.zip') || lower.endsWith('.html');
	}

	private async isHtmlFile(filePath: string): Promise<boolean> {
		const adapter = this.app.vault.adapter;
		try {
			if (Platform.isDesktop) {
				const fs = require('fs');
				const fullPath = this.app.vault.adapter.getFullPath(filePath);
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
					stream.on('error', (err) => {
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
