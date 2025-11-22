import {Plugin, Notice, Modal, Setting, TFolder, TFile, normalizePath} from 'obsidian';
import {
	MiniManagerSettings,
	DEFAULT_SETTINGS,
	MiniManagerSettingsTab
} from '../settings/MiniManagerSettings';
import { MMFApiService } from '../services/MMFApiService';
import { MMFDownloader } from '../services/MMFDownloader';
import { DownloadManagerModal } from '../ui/DownloadManagerModal';
import { MMFDownloadModal } from '../ui/MMFDownloadModal';
import { MMFSearchModal } from '../ui/MMFSearchModal';

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
				new MMFSearchModal(this.app, this).open();
			}
		});

		// Register download by ID command
		this.addCommand({
			id: 'download-mmf-object-by-id',
			name: 'Download MyMiniFactory Object by ID',
			callback: () => {
				new MMFDownloadModal(this.app, this).open();
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
