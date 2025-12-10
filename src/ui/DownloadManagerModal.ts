import { App, Modal, Notice, Setting } from 'obsidian';
import { DownloadManager, DownloadJob } from '../services/DownloadManager';
import MiniManagerPlugin from '../core/MiniManagerPlugin';
import { ValidationService } from '../services/ValidationService';
import { ValidationModal } from './ValidationModal';


export class DownloadManagerModal extends Modal {
    private downloadManager: DownloadManager;
    private jobsContainer: HTMLElement;
    private statsContainer: HTMLElement;
    private statsTopRow?: HTMLElement;
    private statsBottomRow?: HTMLElement;
    private statsCards: Map<string, HTMLElement> = new Map();
    private listener: (jobs: DownloadJob[]) => void;
    private plugin: MiniManagerPlugin;
    private objectId: string = "";
    private clearCompletedButton?: HTMLButtonElement;
    private clearFailedButton?: HTMLButtonElement;
    private downloadButton?: HTMLButtonElement;

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
                .setCta()
                .setButtonText('Download')
                .onClick(() => {
                    this.downloadButton = button.buttonEl;
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
                this.clearCompletedButton = button.buttonEl;
                button
                    .setButtonText(`Clear Completed (${completedCount})`)
                    .onClick(() => {
                        this.downloadManager.clearCompleted();
					});
            })
            .addButton(button => {
                const failedCount = this.downloadManager.getFailedJobsCount();
                this.clearFailedButton = button.buttonEl;
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
                .setButtonText('Pause Downloads')
                .onClick(() => {
                    this.plugin.downloader.pauseDownloads();
                }))
            .addButton(button => button
                .setButtonText('Resume Downloads')
                .onClick(() => {
                    this.plugin.downloader.resumeDownloads();
                }));

        this.statsContainer = contentEl.createDiv('download-stats');
        this.renderStats();

        this.jobsContainer = contentEl.createDiv('jobs-container');
        this.renderJobs();

        this.listener = (jobs) => {
            this.renderJobs(jobs);
            this.redrawButtons(contentEl);
            this.renderStats();
        };
        this.downloadManager.subscribe(this.listener);
    }

    private redrawButtons(contentEl: HTMLElement) {
        if (this.clearCompletedButton) {
            const completedCount = this.downloadManager.getCompletedJobsCount();
            this.clearCompletedButton.textContent = `Clear Completed (${completedCount})`;
            this.clearCompletedButton.disabled = completedCount === 0;
        }

        if (this.clearFailedButton) {
            const failedCount = this.downloadManager.getFailedJobsCount();
            this.clearFailedButton.textContent = `Clear Failed (${failedCount})`;
            this.clearFailedButton.disabled = failedCount === 0;
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

            this.applyProgressStyle(progressBar, job.status);

            const actionEl = detailsEl.createDiv('download-job-action');

            if (job.status === 'failed') {
                const retryButton = actionEl.createEl('button', { text: 'Retry' });
                retryButton.addEventListener('click', () => {
                    this.retryDownload(job.id);
                });
            } else if (job.status === '80_completed') {
                const clearButton = actionEl.createEl('button', { text: 'Clear' });
                clearButton.addEventListener('click', () => {
                    this.downloadManager.removeJob(job.id);
                });
            } else if (['pending', '70_downloading', '30_preparing', '50_downloading_images', '10_validating', '20_validated', '40_prepared', '60_images_downloaded', '00_queued'].includes(job.status)) {
                const cancelButton = actionEl.createEl('button', { text: 'Cancel' });
                cancelButton.addEventListener('click', () => {
                    this.plugin.downloader.cancelDownload(job.id);
                });
            }
        }
    }

    private applyProgressStyle(progressEl: HTMLProgressElement, status: DownloadJob['status']) {
        const setColor = (varName: string) => {
            progressEl.style.setProperty('accent-color', `var(${varName})`);
        };

        const paused = this.plugin.downloader.isPausedState() || status === 'cancelled';

        if (paused) {
            setColor('--text-warning');
            progressEl.classList.add('paused');
            return;
        }

        progressEl.className = ''; // reset incidental classes

        if (status === 'failed') {
            setColor('--text-error');
            progressEl.classList.add('error');
        } else if (status === '80_completed') {
            setColor('--text-success');
            progressEl.classList.add('complete');
        } else if (status === '00_queued' || status === 'pending') {
            setColor('--text-muted');
            progressEl.classList.add('queued');
        } else {
            setColor('--interactive-accent');
            progressEl.classList.add('processing');
        }
    }

    private async renderStats() {
        if (!this.statsContainer) return;
        if (!this.statsContainer.hasClass('download-stats')) {
            this.statsContainer.addClass('download-stats');
        }

        if (!this.statsTopRow) {
            this.statsTopRow = this.statsContainer.createDiv('stats-row');
        }
        if (!this.statsBottomRow) {
            this.statsBottomRow = this.statsContainer.createDiv('stats-row stats-row-secondary');
        }

        try {
            const counts = await this.plugin.fileStateService.getStateCounts();
            const merged = this.mergeCounts(counts);
            const topKeys = ['queued', 'validating', 'preparing', 'downloading_image', 'downloading_files'];
            const bottomKeys = ['completed', 'failed', 'cancelled'];

            const updateCard = (row: HTMLElement, key: string, value: string) => {
                let card = this.statsCards.get(key);
                if (!card) {
                    card = row.createDiv('stats-card');
                    card.createDiv('stats-count');
                    const labelEl = card.createDiv('stats-label');
                    labelEl.setText(key.replace("_", " "));
                    this.statsCards.set(key, card);
                    card.setAttr('data-key', key);
                    card.setAttr('data-label', key.replace("_", " "));
                }
                const countEl = card.querySelector('.stats-count') as HTMLElement;
                if (countEl) countEl.setText(value);
            };

            topKeys.forEach(key => {
                if (merged[key] !== undefined) {
                    updateCard(this.statsTopRow!, key, `${merged[key]}`);
                }
            });

            bottomKeys.forEach(key => {
                if (merged[key] !== undefined) {
                    updateCard(this.statsBottomRow!, key, `${merged[key]}`);
                }
            });

            // Hide cards not used anymore to avoid flicker from removals
            const activeKeys = new Set([...topKeys, ...bottomKeys].filter(k => merged[k] !== undefined));
            this.statsCards.forEach((card, key) => {
                const hidden = !activeKeys.has(key);
                card.toggleClass('hidden', hidden);
            });
        } catch (e) {
            console.error(e);
        }
    }

	private mergeCounts(counts: Record<string, number>): Record<string, string> {
        const get = (key: string) => counts[key] || 0;

        const validatingLabel = `${get('validating')}/${get('validated')}`;
        const preparingLabel = `${get('preparing')}/${get('prepared')}`;
        const downloadingImagesLabel = `${get('downloading_images')}/${get('images_downloaded')}`;
        const downloadingFilesLabel = `${get('downloading')}`;

        const queued = get('queued');
        const completed = get('completed');
        const failed = get('failed') + get('failure_auth') + get('failure_unknown');
        const cancelled = get('cancelled');

        return {
            queued: `${queued}`,
            validating: validatingLabel,
            preparing: preparingLabel,
			downloading_image: downloadingImagesLabel,
			downloading_files: downloadingFilesLabel,
            completed: `${completed}`,
            failed: `${failed}`,
            cancelled: `${cancelled}`
        };
    }
}
