import {Plugin, Notice, normalizePath} from 'obsidian';
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
import { ValidationModal } from '../ui/ValidationModal';

export default class MiniManagerPlugin extends Plugin {
	settings: MiniManagerSettings;
	apiService: MMFApiService;
	downloader: MMFDownloader;
	searchService: SearchService;
	logger: LoggerService;
	oauth2Service: OAuth2Service;
	fileStateService: FileStateService;
	downloadManager: DownloadManager;
	validationService: ValidationService;

	async onload() {
		console.log('Loading Mini Manager plugin');

		// Initialize services
		this.logger = LoggerService.getInstance(this.app);
		await this.loadSettings();
		
		// Initialize state and download management services
		this.fileStateService = FileStateService.getInstance(this.app, this.logger);
		await this.fileStateService.init();
		this.downloadManager = DownloadManager.getInstance(this.fileStateService);

		// Initialize services that depend on settings
		this.oauth2Service = new OAuth2Service(this.settings, this.logger);
		this.apiService = new MMFApiService(this.settings, this.logger, this.oauth2Service);
		this.validationService = new ValidationService(this.app, this.settings, this.fileStateService);

		this.downloader = new MMFDownloader(this.app, this.settings, this.logger, this.oauth2Service, this.validationService);
		this.searchService = new SearchService(this.app, this.settings);

		// Add recovery and resume logic
		await this.recoverOrphanedJobs();
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

		this.addCommand({
			id: 'requeue-active-jobs',
			name: 'Re-queue active jobs',
			callback: async () => {
				const requeuedIds = await this.fileStateService.requeueActiveJobs();
				this.logger.info(`Re-queued ${requeuedIds.length} active job(s) from job files${requeuedIds.length ? `: ${requeuedIds.join(', ')}` : ''}.`);
				new Notice(`Re-queued ${requeuedIds.length} active job${requeuedIds.length === 1 ? '' : 's'}.`, 5000);
			}
		});

		this.addCommand({
			id: 'validate-all-models',
			name: 'Validate all downloaded models',
			callback: async () => {
				new Notice('Starting validation...');
				const results = await this.validationService.validate();
				new ValidationModal(this.app, this, results).open();
				new Notice(`Validation complete. Found ${results.filter(r => !r.isValid).length} issues.`);
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

	async recoverOrphanedJobs() {
		this.logger.info("Checking for orphaned jobs...");
		const jobAdapter = this.app.vault.adapter;
		const jobsDir = normalizePath(`${this.app.vault.configDir}/plugins/mini-manager/jobs`);

		if (!await jobAdapter.exists(jobsDir)) {
			return;
		}

		const allJobFiles = await jobAdapter.list(jobsDir);
		const allKnownStateIds = await this.fileStateService.getAllJobIds();
		const knownIdSet = new Set(allKnownStateIds);

		for (const jobFile of allJobFiles.files) {
			const objectId = jobFile.split('/').pop()?.replace('.json', '');
			if (objectId && !knownIdSet.has(objectId)) {
				// This is an orphan
				this.logger.warn(`Found orphaned job: ${objectId}. Re-queueing.`);
				
                const job = await this.downloadManager.getJob(objectId);
                if (job && job.status !== '80_completed' && job.status !== 'failed' && job.status !== 'cancelled') {
				    await this.fileStateService.add('00_queued', objectId);
                    await this.downloadManager.updateJob(objectId, '00_queued', 0, 'Re-queued after crash');
                } else if (!job) {
                    // Job file exists but couldn't be loaded or is not in a terminal state.
                    await this.fileStateService.add('00_queued', objectId);
                }
			}
		}
	}

	async resumeInterruptedDownloads() {
		this.logger.info("Checking for interrupted downloads...");
		// Include all non-terminal states so we re-queue anything that was mid-flight
		const transientStates = [
			'10_validating',
			'20_validated',
			'30_preparing',
			'40_prepared',
			'50_downloading_images',
			'60_images_downloaded',
			'70_downloading'
		];

		for (const state of transientStates) {
			const ids = await this.fileStateService.getAll(state);
			for (const id of ids) {
				this.logger.info(`Download for ${id} was interrupted in ${state} state. Re-queueing.`);
				await this.fileStateService.move(state, '00_queued', id);
				const job = await this.downloadManager.getJob(id);
				if (job) {
					await this.downloadManager.updateJob(id, '00_queued', 0, 'Re-queued after interruption');
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
