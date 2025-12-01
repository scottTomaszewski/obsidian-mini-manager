import { App } from 'obsidian';
import { MiniManagerSettings } from '../settings/MiniManagerSettings';
import { MMFObject } from '../models/MMFObject';

export interface ValidationResult {
    object: MMFObject;
    folderPath: string;
    isValid: boolean;
    errors: string[];
}

export class ValidationService {
    private app: App;
    private settings: MiniManagerSettings;

    constructor(app: App, settings: MiniManagerSettings) {
        this.app = app;
        this.settings = settings;
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
                        return this.validateObject(object, objectFolder);
                    })();
                    validationPromises.push(validationPromise);
                }
            }
        }

        return Promise.all(validationPromises);
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
                const expectedFiles = object.files.items.map(f => `${filesPath}/${f.filename}`);
                for (const expectedFile of expectedFiles) {
                    if (!downloadedFiles.files.includes(expectedFile)) {
                        errors.push(`Missing file: ${expectedFile}`);
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
}
