import {Plugin, Notice, Modal, Setting, TFolder, TFile, normalizePath} from 'obsidian';
import {
	MiniManagerSettings,
	DEFAULT_SETTINGS,
	MiniManagerSettingsTab
} from '../settings/MiniManagerSettings';
import { MMFApiService } from '../services/MMFApiService';
import { MMFDownloader } from '../services/MMFDownloader';
import { MMFObject } from '../models/MMFObject';
import { DownloadManagerModal } from '../ui/DownloadManagerModal';

export default class MiniManagerPlugin extends Plugin {
	settings: MiniManagerSettings;
	apiService: MMFApiService;
	downloader: MMFDownloader;

	async onload() {
		console.log('Loading Mini Manager plugin');

		// Initialize settings
		await this.loadSettings();

		// Initialize services
		this.apiService = new MMFApiService(this.settings);
		this.downloader = new MMFDownloader(this.app, this.settings);

		// Check if API key is set and show a notice if it's not
		if (!this.settings.mmfApiKey) {
			new Notice('Please set your MyMiniFactory API key in the settings.', 10000);
		}

		// Register search command
		this.addCommand({
			id: 'search-mmf-objects',
			name: 'Search MyMiniFactory Objects',
			callback: () => {
				new MMFSearchModal(this).open();
			}
		});

		// Register download by ID command
		this.addCommand({
			id: 'download-mmf-object-by-id',
			name: 'Download MyMiniFactory Object by ID',
			callback: () => {
				new MMFDownloadModal(this).open();
			}
		});

		this.addCommand({
			id: 'open-download-manager',
			name: 'Open Download Manager',
			callback: () => {
				new DownloadManagerModal(this.app, this).open();
			}
		});

		// Register settings tab
		this.addSettingTab(new MiniManagerSettingsTab(this.app, this));
	}

	onunload() {
		// Clean up resources if needed
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
} 

class MMFSearchModal extends Modal {
	plugin: MiniManagerPlugin;
	query: string = "";
	searchResults: MMFObject[] = [];
	resultContainerEl: HTMLElement;

	constructor(plugin: MiniManagerPlugin) {
		super(plugin.app);
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

class MMFDownloadModal extends Modal {
	plugin: MiniManagerPlugin;
	objectId: string = "";

	constructor(plugin: MiniManagerPlugin) {
		super(plugin.app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: 'Download MyMiniFactory Object by ID' });

		new Setting(contentEl)
			.setName('Object ID')
			.setDesc('Enter the MyMiniFactory object ID to download')
			.addText((text) =>
				text.onChange((value) => {
					this.objectId = value;
				}));

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText('Download')
					.setCta()
					.onClick(async () => {
						if (!this.objectId) {
							new Notice('Please enter an object ID');
							return;
						}

						try {
							new Notice(`Downloading object ${this.objectId}...`);
							await this.plugin.downloader.downloadObject(this.objectId);
							new Notice(`Successfully downloaded object ${this.objectId}`);
							this.close();
						} catch (error) {
							new Notice(`Error: ${error.message}`);
							console.error(error);
						}
					}));
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
