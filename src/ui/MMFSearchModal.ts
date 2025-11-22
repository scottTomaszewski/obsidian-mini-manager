import { App, Modal, Notice, Setting } from "obsidian";
import { MMFObject } from "../models/MMFObject";
import MiniManagerPlugin from "../core/MiniManagerPlugin";

export class MMFSearchModal extends Modal {
	plugin: MiniManagerPlugin;
	query: string = "";
	searchResults: MMFObject[] = [];
	resultContainerEl: HTMLElement;

	constructor(app: App, plugin: MiniManagerPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: 'Search MyMiniFactory' });

		// Search input
		new Setting(contentEl)
			.setName('Search Query')
			.addText((text) =>
				text.onChange((value) => {
					this.query = value;
				}));

		// Search button
		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText('Search')
					.setCta()
					.onClick(async () => {
						if (!this.query) {
							new Notice('Please enter a search query');
							return;
						}
						
						try {
							new Notice('Searching MyMiniFactory...');
							this.searchResults = await this.plugin.apiService.searchObjects(this.query);
							this.displaySearchResults();
						} catch (error) {
							new Notice(`Error: ${error.message}`);
							console.error(error);
						}
					}));

		// Results container
		this.resultContainerEl = contentEl.createDiv();
	}

	displaySearchResults() {
		this.resultContainerEl.empty();

		if (this.searchResults.length === 0) {
			this.resultContainerEl.createEl('p', { text: 'No results found' });
			return;
		}

		const resultsEl = this.resultContainerEl.createEl('div', { cls: 'mmf-search-results' });
		
		for (const result of this.searchResults) {
			const resultEl = resultsEl.createEl('div', { cls: 'mmf-result-item' });
			
			resultEl.createEl('h3', { text: result.name });
			
			const metaEl = resultEl.createEl('div', { cls: 'mmf-result-meta' });
			if (result.designer) {
				metaEl.createEl('span', { text: `ID: ${result.id} | Designer: ${result.designer.name}` });
			} else {
				metaEl.createEl('span', { text: `ID: ${result.id}` });
			}
			
			if (result.description) {
				resultEl.createEl('p', { text: result.description.substring(0, 100) + '...' });
			}

			new Setting(resultEl)
				.addButton((btn) =>
					btn
						.setButtonText('Download')
						.setCta()
						.onClick(async () => {
							try {
								new Notice(`Downloading "${result.name}"...`);
								await this.plugin.downloader.downloadObject(String(result.id));
								new Notice(`Successfully downloaded "${result.name}"`);
							} catch (error) {
								new Notice(`Error downloading: ${error.message}`);
								console.error(error);
							}
						}));
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
