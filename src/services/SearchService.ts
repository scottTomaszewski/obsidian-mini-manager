import { App, TFile } from 'obsidian';
import { MMFObject } from '../models/MMFObject';
import { MiniManagerSettings } from '../settings/MiniManagerSettings';

export class SearchService {
    private app: App;
    private settings: MiniManagerSettings;
    private index: MMFObject[] = [];

    constructor(app: App, settings: MiniManagerSettings) {
        this.app = app;
        this.settings = settings;
    }

    async buildIndex() {
        this.index = [];
        const downloadPath = this.settings.downloadPath;
        const files = this.app.vault.getFiles();
        for (const file of files) {
            if (file.path.startsWith(downloadPath) && file.name === 'mmf-metadata.json') {
                const content = await this.app.vault.cachedRead(file);
                try {
                    const object = JSON.parse(content);
                    this.index.push(object);
                } catch (e) {
                    console.error(`Failed to parse metadata file: ${file.path}`, e);
                }
            }
        }
    }

    search(query: string): MMFObject[] {
        if (!query) {
            return [];
        }
        const lowerCaseQuery = query.toLowerCase();
        return this.index.filter(object => {
            const nameMatch = object.name.toLowerCase().includes(lowerCaseQuery);
            const tagMatch = object.tags && object.tags.some(tag => tag.toLowerCase().includes(lowerCaseQuery));
            const designerMatch = object.designer && object.designer.name.toLowerCase().includes(lowerCaseQuery);
            return nameMatch || tagMatch || designerMatch;
        });
    }
}
