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
import { ACTIVE_STATES, FileStateService } from '../services/FileStateService';
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
		// Initialize services
		// Where state has always been kept, whatever folder the plugin was installed into.
		const pluginDir = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
		this.logger = new LoggerService(this.app, pluginDir);
		await this.loadSettings();
		
		// Initialize state and download management services
		this.fileStateService = new FileStateService(this.app, this.logger, pluginDir);
		await this.fileStateService.init();
		this.downloadManager = new DownloadManager(this.fileStateService);
		await this.downloadManager.init();

		// Initialize services that depend on settings
		this.oauth2Service = new OAuth2Service(this.settings, this.logger, () => this.saveSettings());
		this.apiService = new MMFApiService(this.settings, this.logger, this.oauth2Service);
		this.validationService = new ValidationService(this.app, this.settings, this.fileStateService);

		this.downloader = new MMFDownloader(
			this.app,
			this.settings,
			this.logger,
			this.oauth2Service,
			this.apiService,
			this.validationService,
			this.fileStateService,
			this.downloadManager,
			pluginDir
		);
		this.searchService = new SearchService(this.app, this.settings);

		// Logging in again retries whatever failed on authentication.
		this.oauth2Service.onAuthenticated = () => {
			this.downloader.resumeDownloads().catch(error => {
				this.logger.error(`Failed to resume downloads after login: ${error.message}`);
			});
		};

		// Add recovery and resume logic
		await this.recoverOrphanedJobs();
		await this.resumeInterruptedDownloads();

		// Nothing works until the user has logged in
		if (!this.oauth2Service.hasToken()) {
			new Notice('Please log in to MyMiniFactory in the Mini Manager settings.', 10000);
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
			id: 'retry-failed-downloads',
			name: 'Retry failed downloads',
			callback: async () => {
				const retried = await this.downloader.retryFailed();
				new Notice(`Retrying ${retried} failed model${retried === 1 ? '' : 's'}.`, 5000);
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
		this.downloader.start();
	}

	/** Queues jobs that have a job file but, after a crash, no state to say where they are. */
	async recoverOrphanedJobs() {
		this.logger.info("Checking for orphaned jobs...");
		for (const job of this.downloadManager.getJobs()) {
			const finished = job.status === '80_completed' || job.status === 'failed' || job.status === 'cancelled';
			if (this.fileStateService.getState(job.id) === undefined && !finished) {
				this.logger.warn(`Found orphaned job: ${job.id}. Re-queueing.`);
				await this.fileStateService.add('00_queued', job.id);
				await this.downloadManager.updateJob(job.id, '00_queued', 0, 'Re-queued after crash');
			}
		}
	}

	async resumeInterruptedDownloads() {
		this.logger.info("Checking for interrupted downloads...");
		// Anything that was mid-flight goes back to the start of the queue.
		const transientStates = ACTIVE_STATES.filter(state => state !== '00_queued');

		for (const state of transientStates) {
			const ids = await this.fileStateService.getAll(state);
			for (const id of ids) {
				this.logger.info(`Download for ${id} was interrupted in ${state} state. Re-queueing.`);
				await this.fileStateService.move(state, '00_queued', id);
				await this.downloadManager.updateJob(id, '00_queued', 0, 'Re-queued after interruption');
			}
		}
	}

	onunload() {
		this.downloader?.shutdown();
		this.fileStateService?.close();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
