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
		this.modalEl.addClass('mini-manager-modal');
		const {contentEl} = this;
		contentEl.createEl('h2', {text: 'Validation Results'});

		new Setting(contentEl)
			.setName('Show only failed')
			.addToggle(toggle => toggle
				.setValue(this.showOnlyFailed)
				.onChange(value => {
					this.showOnlyFailed = value;
					this.renderResults();
				}));

		new Setting(contentEl)
			.addButton(button => {
				const selectedCount = this.selectedResults.length;
				button
					.setButtonText(`Retry Selected (${selectedCount})`)
					.setCta()
					// disabling the button from the buttonEl doesnt seem to work.  I need to disable from the buttonComponent
					// .setDisabled(selectedCount === 0)
					.onClick(() => this.retrySelected());
			})
			.addButton(button => {
				const failedCount = this.results.filter(result => !result.isValid).length;
				button
					.setButtonText(`Select All Failed (${failedCount})`)
					.onClick(() => this.selectAllFailed());
			});

		this.resultsContainer = contentEl.createDiv('validation-results-container');
		this.renderResults();
	}

	onClose() {
		this.contentEl.empty();
	}

	private redrawButtons() {
		const retryButton = this.contentEl.querySelector('.setting-item-control button:first-child') as HTMLButtonElement;
		const selectAllButton = this.contentEl.querySelector('.setting-item-control button:nth-child(2)') as HTMLButtonElement;

		if (retryButton) {
			const selectedCount = this.selectedResults.length;
			retryButton.textContent = `Retry Selected (${selectedCount})`;
			// retryButton.setDisabled(selectedCount === 0);
		}

		if (selectAllButton) {
			const failedCount = this.results.filter(result => !result.isValid).length;
			selectAllButton.textContent = `Select All Failed (${failedCount})`;
		}
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
			this.resultsContainer.createEl('p', {text: 'No validation issues found.'});
			this.redrawButtons();
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
				const checkbox = checkboxContainer.createEl('input', {type: 'checkbox'});
				// Check if the current result is in selectedResults using object.id for comparison
				checkbox.checked = this.selectedResults.some(s => s.object.id === result.object.id);
				checkbox.addEventListener('change', () => {
					if (checkbox.checked) {
						this.selectedResults.push(result);
					} else {
						this.selectedResults = this.selectedResults.filter(r => r.object.id !== result.object.id);
					}
					this.redrawButtons();
				});
				// The checkbox is now prepended to resultEl, before the Setting component
				// setting.controlEl.prepend(checkbox); // This line is no longer needed

				const errorsEl = resultEl.createEl('ul');
				for (const error of result.errors) {
					errorsEl.createEl('li', {text: error});
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
		this.redrawButtons();
	}
}
