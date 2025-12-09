import { App, Platform } from 'obsidian';
import { MiniManagerSettings } from '../settings/MiniManagerSettings';
import { MMFObject } from '../models/MMFObject';
import { FileStateService } from './FileStateService';

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
                    if (object.id === objectId) {
                        return objectFolder;
                    }
                }
            }
        }

        return null;
    }

    private async validateObject(object: MMFObject, folderPath: string): Promise<ValidationResult> {
        const errors: string[] = [];
        const adapter = this.app.vault.adapter;

        // 1. Validate README frontmatter
        const readmePath = `${folderPath}/README.md`;
        if (await adapter.exists(readmePath)) {
            // This is a simplified check. A more robust implementation would parse the frontmatter.
            const readmeContent = await adapter.read(readmePath);
            if (!readmeContent.startsWith('---') || !readmeContent.includes('---')) {
                errors.push('README.md is missing frontmatter.');
            }
        } else {
            errors.push('README.md is missing.');
        }

        // 2. Validate images
        const imagesPath = `${folderPath}/images`;
        if (this.settings.downloadImages && object.images && object.images.length > 0) {
            if (await adapter.exists(imagesPath)) {
                const downloadedImages = await adapter.list(imagesPath);
                if (downloadedImages.files.length < object.images.length) {
                    errors.push(`Missing images. Expected ${object.images.length}, found ${downloadedImages.files.length}.`);
                }
            } else {
                errors.push('Images folder is missing.');
            }
        }

        // 3. Validate files
        const filesPath = `${folderPath}/files`;
        if (this.settings.downloadFiles && object.files && object.files.items.length > 0) {
            if (await adapter.exists(filesPath)) {
                const downloadedFiles = await adapter.list(filesPath);
                for (const item of object.files.items) {
                    const expectedFilePath = `${filesPath}/${item.filename}`;
                    if (!downloadedFiles.files.includes(expectedFilePath)) {
                        errors.push(`Missing file: ${item.filename}`);
                    } else if (item.filename.toLowerCase().endsWith('.zip') || item.filename.toLowerCase().endsWith('.html')) {
                        // Check if a zip file is actually an HTML file
                        if (await this.isHtmlFile(expectedFilePath)) {
                            errors.push(`File ${item.filename} is HTML content, not a valid file (possible login redirect).`);
                        }
                    }
                }
            } else {
                errors.push('Files folder is missing.');
            }
        }

        return {
            object,
            folderPath,
            isValid: errors.length === 0,
            errors,
        };
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
						this.app.console.error(`Error reading file for HTML check: ${filePath}`, err);
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
			this.app.console.error(`Error reading file for HTML check: ${filePath}`, error);
			return false;
		}
	}
}
