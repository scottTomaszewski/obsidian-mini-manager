import { App, Modal, Notice, Setting } from "obsidian";
import MiniManagerPlugin from "../core/MiniManagerPlugin";

export class MMFDownloadModal extends Modal {
	plugin: MiniManagerPlugin;
	objectId: string = "";

	constructor(app: App, plugin: MiniManagerPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: 'Download MyMiniFactory Object by ID' });

		new Setting(contentEl)
			.setName('Object ID')
			.setDesc('Enter the MyMiniFactory object ID to download')
			.addText((text) =>
				text.onChange((value) => {
					this.objectId = value;
				}));

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText('Download')
					.setCta()
					.onClick(async () => {
						if (!this.objectId) {
							new Notice('Please enter an object ID');
							return;
						}

						try {
							new Notice(`Downloading object ${this.objectId}...`);
							await this.plugin.downloader.downloadObject(this.objectId);
							new Notice(`Successfully downloaded object ${this.objectId}`);
							this.close();
						} catch (error) {
							new Notice(`Error: ${error.message}`);
							console.error(error);
						}
					}));
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
