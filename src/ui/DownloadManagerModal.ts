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
        this.modalEl.addClass('mini-manager-modal');
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Download Manager' });

        // Drag and drop functionality
        contentEl.addEventListener('dragover', (event) => {
            event.preventDefault();
        });

        contentEl.addEventListener('dragenter', (event) => {
            // Check if the drag is coming from outside the element
            if (!contentEl.contains(event.relatedTarget as Node)) {
                contentEl.addClass('drag-over');
            }
        });

        contentEl.addEventListener('dragleave', (event) => {
            // Check if the drag is going to a child element
            if (!contentEl.contains(event.relatedTarget as Node)) {
                contentEl.removeClass('drag-over');
            }
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
            .addButton(button => {
                const completedCount = this.downloadManager.getCompletedJobsCount();
                button
                    .setButtonText(`Clear Completed (${completedCount})`)
                    .setDisabled(completedCount === 0)
                    .onClick(() => {
                        this.downloadManager.clearCompleted();
                    });
            })
            .addButton(button => {
                const failedCount = this.downloadManager.getFailedJobsCount();
                button
                    .setButtonText(`Clear Failed (${failedCount})`)
                    .setDisabled(failedCount === 0)
                    .onClick(() => {
                        this.downloadManager.clearFailed();
                    });
            })
            .addButton(button => button
                .setButtonText('Validate Downloads')
                .onClick(async () => {
                    new Notice('Validation process started...');
                    const results = await this.plugin.validationService.validate();
                    new ValidationModal(this.app, this.plugin, results).open();
					new Notice(`Validation complete. Found ${results.filter(r => !r.isValid).length} issues.`);
                }))
            .addButton(button => button
                .setButtonText('Resume Downloads')
                .onClick(() => {
                    this.plugin.downloader.resumeDownloads();
                }));

        this.jobsContainer = contentEl.createDiv('jobs-container');
        this.renderJobs();

        this.listener = (jobs) => {
            this.renderJobs(jobs);
            this.redrawButtons(contentEl);
        };
        this.downloadManager.subscribe(this.listener);
    }

    private redrawButtons(contentEl: HTMLElement) {
        const clearCompletedButton = contentEl.querySelector('.setting-item-control button:first-child') as HTMLButtonElement;
        const clearFailedButton = contentEl.querySelector('.setting-item-control button:nth-child(2)') as HTMLButtonElement;

        if (clearCompletedButton) {
            const completedCount = this.downloadManager.getCompletedJobsCount();
            clearCompletedButton.textContent = `Clear Completed (${completedCount})`;
            clearCompletedButton.disabled = completedCount === 0;
        }

        if (clearFailedButton) {
            const failedCount = this.downloadManager.getFailedJobsCount();
            clearFailedButton.textContent = `Clear Failed (${failedCount})`;
            clearFailedButton.disabled = failedCount === 0;
        }
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

    private retryDownload(jobId: string) {
        this.downloadManager.removeJob(jobId);
        this.plugin.downloader.downloadObject(jobId).catch(error => {
            new Notice(`Error queuing object ${jobId}: ${error.message}`);
            console.error(`Error queuing object ${jobId}:`, error);
        });
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
                .setName(job.object.name);

            const detailsEl = jobEl.createDiv('download-job-details');

            detailsEl.createEl('span', {
                text: job.error ? `Error: ${job.error}` : job.progressMessage,
                cls: 'setting-item-description'
            });

            const progressBar = detailsEl.createEl('progress', {
                attr: {
                    value: job.progress,
                    max: 100,
                },
            });

            if (job.status === 'failed') {
                progressBar.addClass('error');
                const retryButton = detailsEl.createEl('button', { text: 'Retry' });
                retryButton.addEventListener('click', () => {
                    this.retryDownload(job.id);
                });
            } else if (job.status === 'completed') {
                const clearButton = detailsEl.createEl('button', { text: 'Clear' });
                clearButton.addEventListener('click', () => {
                    this.downloadManager.removeJob(job.id);
                });
            } else if (['pending', 'downloading', 'extracting', 'preparing', 'downloading_images'].includes(job.status)) {
                const cancelButton = detailsEl.createEl('button', { text: 'Cancel' });
                cancelButton.addEventListener('click', () => {
                    this.plugin.downloader.cancelDownload(job.id);
                });
            }
        }
    }
}
