import { App, Modal, Setting } from 'obsidian';
import { ValidationResult } from './ValidationService';

export class ValidationModal extends Modal {
    private results: ValidationResult[];
    private showOnlyFailed: boolean = false;
    private resultsContainer: HTMLElement;

    constructor(app: App, results: ValidationResult[]) {
        super(app);
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

        this.resultsContainer = contentEl.createDiv('validation-results-container');
        this.renderResults();
    }

    onClose() {
        this.contentEl.empty();
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
            const status = result.isValid ? '✅ Valid' : `❌ Invalid`;
            
            new Setting(resultEl)
                .setName(`${result.object.name} - ${status}`)
                .setDesc(result.folderPath);

            if (!result.isValid) {
                const errorsEl = resultEl.createEl('ul');
                for (const error of result.errors) {
                    errorsEl.createEl('li', { text: error });
                }
            }
        }
    }
}
