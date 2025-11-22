import { App, Modal, Setting } from 'obsidian';
import { DownloadManager, DownloadJob } from '../services/DownloadManager';
import MiniManagerPlugin from '../core/MiniManagerPlugin';
import { MMFDownloadModal } from './MMFDownloadModal';

export class DownloadManagerModal extends Modal {
    private downloadManager: DownloadManager;
    private jobsContainer: HTMLElement;
    private listener: (jobs: DownloadJob[]) => void;
    private plugin: MiniManagerPlugin;

    constructor(app: App, plugin: MiniManagerPlugin) {
        super(app);
        this.plugin = plugin;
        this.downloadManager = DownloadManager.getInstance();
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Download Manager' });

        new Setting(contentEl)
            .addButton(button => button
                .setButtonText('Add New Download')
                .onClick(() => {
                    new MMFDownloadModal(this.app, this.plugin).open();
                }))
            .addButton(button => button
                .setButtonText('Clear Completed')
                .onClick(() => {
                    this.downloadManager.clearCompleted();
                }));

        this.jobsContainer = contentEl.createDiv('jobs-container');
        this.renderJobs();

        this.listener = (jobs) => this.renderJobs(jobs);
        this.downloadManager.subscribe(this.listener);
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
        this.downloadManager.unsubscribe(this.listener);
    }

    private renderJobs(jobs: DownloadJob[] = this.downloadManager.getJobs()) {
        this.jobsContainer.empty();

        if (jobs.length === 0) {
            this.jobsContainer.createEl('p', { text: 'No active downloads.' });
            return;
        }

        for (const job of jobs) {
            const jobEl = this.jobsContainer.createDiv('download-job');

            new Setting(jobEl)
                .setName(job.object.name)
                .setDesc(job.status.charAt(0).toUpperCase() + job.status.slice(1));

            const progressBar = jobEl.createEl('progress', {
                attr: {
                    value: job.progress,
                    max: 100,
                },
            });

            if (job.error) {
                jobEl.createEl('p', { text: `Error: ${job.error}`, cls: 'error-message' });
            }
        }
    }
}
