import { App, Modal, Notice, Setting } from 'obsidian';
import { ValidationResult } from '../services/ValidationService';
import MiniManagerPlugin from '../core/MiniManagerPlugin';

export class ValidationModal extends Modal {
    private results: ValidationResult[];
    private showOnlyFailed: boolean = true;
    private resultsContainer: HTMLElement;
    private plugin: MiniManagerPlugin;
    private selectedResults: ValidationResult[] = [];

    constructor(app: App, plugin: MiniManagerPlugin, results: ValidationResult[]) {
        super(app);
        this.plugin = plugin;
        this.results = results;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Validation Results' });

        new Setting(contentEl)
            .setName('Show only failed')
            .addToggle(toggle => toggle
                .setValue(this.showOnlyFailed)
                .onChange(value => {
                    this.showOnlyFailed = value;
                    this.renderResults();
                }));

        new Setting(contentEl)
            .addButton(button => button
                .setButtonText('Retry Selected')
                .setCta() // Make it a call to action button
                .onClick(() => this.retrySelected()))
            .addButton(button => button
                .setButtonText('Select All Failed')
                .onClick(() => this.selectAllFailed()));

        this.resultsContainer = contentEl.createDiv('validation-results-container');
        this.renderResults();
    }

    onClose() {
        this.contentEl.empty();
    }

    private async retrySelected() {
        if (this.selectedResults.length === 0) {
            new Notice('No items selected.');
            return;
        }

        const promises = this.selectedResults.map(result => {
            return (async () => {
                const adapter = this.app.vault.adapter;
                // It's possible the folder might have been deleted by another retry
                if (await adapter.exists(result.folderPath)) {
                     await adapter.rmdir(result.folderPath, true);
                }
                await this.plugin.downloader.downloadObject(String(result.object.id));
            })();
        });

        try {
            new Notice(`Retrying ${promises.length} items...`);
            await Promise.all(promises);
            new Notice('All selected items have been retried.');

            const selectedIds = this.selectedResults.map(r => r.object.id);
            this.results = this.results.filter(r => !selectedIds.includes(r.object.id));
            this.selectedResults = []; // Clear selection after retry
            this.renderResults();
        } catch (error) {
            new Notice(`An error occurred during retry: ${error.message}`);
            console.error(error);
        }
    }

    private selectAllFailed() {
        this.selectedResults = this.results.filter(result => !result.isValid);
        this.renderResults(); // Re-render to show checkboxes checked
    }

    private renderResults() {
        this.resultsContainer.empty();

        const filteredResults = this.showOnlyFailed
            ? this.results.filter(result => !result.isValid)
            : this.results;

        if (filteredResults.length === 0) {
            this.resultsContainer.createEl('p', { text: 'No validation issues found.' });
            return;
        }

        for (const result of filteredResults) {
            const resultEl = this.resultsContainer.createDiv('validation-result');
            // Create a div for the checkbox and prepend it
            const checkboxContainer = resultEl.createDiv('validation-checkbox-container');


            const status = result.isValid ? '✅ Valid' : `❌ Invalid`;

            const setting = new Setting(resultEl)
                .setName(`${result.object.name} - ${status}`)
                .setDesc(result.folderPath);

            if (!result.isValid) {
                const checkbox = checkboxContainer.createEl('input', { type: 'checkbox' });
                // Check if the current result is in selectedResults using object.id for comparison
                checkbox.checked = this.selectedResults.some(s => s.object.id === result.object.id);
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) {
                        this.selectedResults.push(result);
                    } else {
                        this.selectedResults = this.selectedResults.filter(r => r.object.id !== result.object.id);
                    }
                });
                // The checkbox is now prepended to resultEl, before the Setting component
                // setting.controlEl.prepend(checkbox); // This line is no longer needed

                const errorsEl = resultEl.createEl('ul');
                for (const error of result.errors) {
                    errorsEl.createEl('li', { text: error });
                }

                setting.addButton(button => button
                    .setButtonText('Retry')
                    .onClick(async () => {
                        button.setButtonText('Retrying...').setDisabled(true);
                        const adapter = this.app.vault.adapter;
                        try {
                            // Check existence before attempting to remove
                            if (await adapter.exists(result.folderPath)) {
                                await adapter.rmdir(result.folderPath, true);
                            }

                            new Notice(`Retrying download for "${result.object.name}"...`);
                            await this.plugin.downloader.downloadObject(String(result.object.id));
                            new Notice(`Successfully downloaded "${result.object.name}"`);

                            this.results = this.results.filter(r => r.object.id !== result.object.id);
                            this.selectedResults = this.selectedResults.filter(r => r.object.id !== result.object.id); // Also remove from selected
                            this.renderResults();
                        } catch (error) {
                            new Notice(`Error downloading: ${error.message}`);
                            console.error(error);
                            button.setButtonText('Retry').setDisabled(false);
                        }
                    }));
            }
        }
    }
}
