import {Plugin, Notice} from 'obsidian';
import {
	MiniManagerSettings,
	DEFAULT_SETTINGS,
	MiniManagerSettingsTab
} from '../settings/MiniManagerSettings';
import { MMFApiService } from '../services/MMFApiService';
import { MMFDownloader } from '../services/MMFDownloader';
import { DownloadManagerModal } from '../ui/DownloadManagerModal';
import { MMFSearchModal } from '../ui/MMFSearchModal';
import { SearchService } from '../services/SearchService';
import { LoggerService } from '../services/LoggerService';
import { OAuth2Service } from '../services/OAuth2Service';
import {ValidationService} from "../services/ValidationService";
import { FileStateService } from '../services/FileStateService';
import { DownloadManager } from '../services/DownloadManager';

export default class MiniManagerPlugin extends Plugin {
	settings: MiniManagerSettings;
	apiService: MMFApiService;
	downloader: MMFDownloader;
	searchService: SearchService;
	logger: LoggerService;
	oauth2Service: OAuth2Service;
	fileStateService: FileStateService;
	downloadManager: DownloadManager;

	async onload() {
		console.log('Loading Mini Manager plugin');

		// Initialize services
		this.logger = LoggerService.getInstance(this.app);
		await this.loadSettings();

		// Initialize services that depend on settings
		this.oauth2Service = new OAuth2Service(this.settings, this.logger);
		this.apiService = new MMFApiService(this.settings, this.logger, this.oauth2Service);
		const validationService = new ValidationService(this.app, this.settings);

		// Initialize state and download management services
		this.fileStateService = FileStateService.getInstance(this.app, this.logger);
		await this.fileStateService.init();
		this.downloadManager = DownloadManager.getInstance(this.fileStateService);

		this.downloader = new MMFDownloader(this.app, this.settings, this.logger, this.oauth2Service, validationService);
		this.searchService = new SearchService(this.app, this.settings);

		// Add resume logic for interrupted downloads
		await this.resumeInterruptedDownloads();

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

		this.addCommand({
			id: 'open-download-manager',
			name: 'Open Download Manager',
			callback: () => {
				new DownloadManagerModal(this.app, this).open();
			}
		});

		this.addCommand({
			id: 'resume-downloads',
			name: 'Resume Downloads',
			callback: () => {
				this.downloader.resumeDownloads();
			}
		});

		this.addCommand({
			id: 'start-bulk-download',
			name: 'Start bulk download from file',
			callback: () => {
				this.downloader.startBulkDownload();
			}
		});

		// Register settings tab
		this.addSettingTab(new MiniManagerSettingsTab(this.app, this));

		// Add a ribbon icon
		this.addRibbonIcon('download', 'Open Download Manager', () => {
			new DownloadManagerModal(this.app, this).open();
		});

		// Start processing the queue automatically on load
		this.downloader.resumeDownloads();
	}

	async resumeInterruptedDownloads() {
		this.logger.info("Checking for interrupted downloads...");
		const transientStates = ['downloading', 'validating', 'extracting'];
		for (const state of transientStates) {
			const ids = await this.fileStateService.getAll(state);
			for (const id of ids) {
				this.logger.info(`Download for ${id} was interrupted in ${state} state. Re-queueing.`);
				await this.fileStateService.move(state, 'queued', id);
				const job = await this.downloadManager.getJob(id);
				if (job) {
					await this.downloadManager.updateJob(id, 'queued', 0, 'Re-queued after interruption');
				}
			}
		}
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
