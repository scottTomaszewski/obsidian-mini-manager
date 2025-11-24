import { App, Modal, Notice, Setting } from 'obsidian';
import { DownloadManager, DownloadJob } from '../services/DownloadManager';
import MiniManagerPlugin from '../core/MiniManagerPlugin';
import { ValidationService } from '../services/ValidationService';
import { ValidationModal } from './ValidationModal';


export class DownloadManagerModal extends Modal {
    private downloadManager: DownloadManager;
    private jobsContainer: HTMLElement;
    private listener: (jobs: DownloadJob[]) => void;
    private plugin: MiniManagerPlugin;
    private objectId: string = "";

    constructor(app: App, plugin: MiniManagerPlugin) {
        super(app);
        this.plugin = plugin;
        this.downloadManager = DownloadManager.getInstance();
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Download Manager' });

        // Drag and drop functionality
        contentEl.addEventListener('dragover', (event) => {
            event.preventDefault();
        });

        contentEl.addEventListener('dragenter', () => {
            contentEl.addClass('drag-over');
        });

        contentEl.addEventListener('dragleave', () => {
            contentEl.removeClass('drag-over');
        });

        contentEl.addEventListener('drop', (event) => {
            event.preventDefault();
            contentEl.removeClass('drag-over');

            const text = event.dataTransfer.getData('text/plain');
            this.handleDrop(text);
        });

        new Setting(contentEl)
            .setName('New Download')
            .setDesc('Enter a MyMiniFactory object ID to start a new download.')
            .addText(text => text
                .setPlaceholder('Enter object ID or drop URLs here')
                .onChange(value => {
                    this.objectId = value;
                }))
            .addButton(button => button
                .setButtonText('Download')
                .onClick(() => {
                    if (!this.objectId) {
                        new Notice('Please enter one or more object IDs');
                        return;
                    }

                    const ids = this.objectId.split(/[\s,]+/).filter(id => id.trim() !== '');
                    this.queueDownloads(ids);
                }));

        new Setting(contentEl)
            .addButton(button => button
                .setButtonText('Clear Completed')
                .onClick(() => {
                    this.downloadManager.clearCompleted();
                }))
            .addButton(button => button
                .setButtonText('Validate Downloads')
                .onClick(async () => {
                    new Notice('Validation process started...');
                    // Ensure plugin.settings is passed, as ValidationService needs access to downloadPath etc.
                    const validationService = new ValidationService(this.app, this.plugin.settings);
                    const results = await validationService.validate();
                    new ValidationModal(this.app, results).open();
                }));

        this.jobsContainer = contentEl.createDiv('jobs-container');
        this.renderJobs();

        this.listener = (jobs) => this.renderJobs(jobs);
        this.downloadManager.subscribe(this.listener);
    }

    private handleDrop(text: string) {
        const urlRegex = /https?:\/\/(?:www\.)?myminifactory\.com\/object\/(?:[a-zA-Z0-9-]+\-)?(\d+)/g;
        const ids = [];
        let match;
        while ((match = urlRegex.exec(text)) !== null) {
            ids.push(match[1]);
        }

        if (ids.length > 0) {
            this.queueDownloads(ids);
        } else {
            new Notice('No valid MyMiniFactory object URLs found in the dropped text.');
        }
    }

    private queueDownloads(ids: string[]) {
        if (ids.length === 0) {
            new Notice('Please enter valid object IDs');
            return;
        }

        for (const id of ids) {
            new Notice(`Queuing object ${id} for download...`);
            this.plugin.downloader.downloadObject(id).catch(error => {
                new Notice(`Error queuing object ${id}: ${error.message}`);
                console.error(`Error queuing object ${id}:`, error);
            });
        }
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
                .setDesc(job.progressMessage);

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
