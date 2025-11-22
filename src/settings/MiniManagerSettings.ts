import {App, Notice, PluginSettingTab, Setting} from 'obsidian';
import MiniManagerPlugin from '../core/MiniManagerPlugin';

export interface MiniManagerSettings {
	mmfApiKey: string;
	downloadPath: string;
	downloadImages: boolean;
	downloadFiles: boolean;
	useDirectDownload: boolean;
}

export const DEFAULT_SETTINGS: MiniManagerSettings = {
	mmfApiKey: '',
	downloadPath: 'MyMiniFactory',
	downloadImages: true,
	downloadFiles: true,
	useDirectDownload: false,
};

export class MiniManagerSettingsTab extends PluginSettingTab {
	plugin: MiniManagerPlugin;

	constructor(app: App, plugin: MiniManagerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		new Setting(containerEl).setName('API Configuration').setHeading();

		containerEl.createEl('p', {
			text: 'To authenticate with MyMiniFactory API, you need an API key from the MMF Developer Portal.'
		});
		
		const linkEl = containerEl.createEl('a', {
			text: 'Visit MMF Developer Portal',
			href: 'https://www.myminifactory.com/settings/developer'
		});
		linkEl.setAttr('target', '_blank');
		containerEl.createEl('br');
		containerEl.createEl('br');
		
		new Setting(containerEl)
			.setName('API Key')
			.setDesc('Your MyMiniFactory API Key')
			.addText(text => text
				.setPlaceholder('Enter your API Key')
				.setValue(this.plugin.settings.mmfApiKey)
				.onChange(async (value) => {
					this.plugin.settings.mmfApiKey = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName('Download Settings').setHeading();

		new Setting(containerEl)
			.setName('Download Path')
			.setDesc('Folder where MMF objects will be downloaded (relative to your vault).')
			.addText(text => text
				.setPlaceholder('MyMiniFactory')
				.setValue(this.plugin.settings.downloadPath)
				.onChange(async (value) => {
					this.plugin.settings.downloadPath = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Download Images')
			.setDesc('Download preview images with the object.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.downloadImages)
				.onChange(async (value) => {
					this.plugin.settings.downloadImages = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Download Files')
			.setDesc('Download the object files (STLs, etc).')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.downloadFiles)
				.onChange(async (value) => {
					this.plugin.settings.downloadFiles = value;
					await this.plugin.saveSettings();
				})
			);
			
		new Setting(containerEl)
			.setName('Direct Download Method')
			.setDesc('WARNING: May fail due to CORS issues. Disable to use alternative download methods.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.useDirectDownload)
				.onChange(async (value) => {
					this.plugin.settings.useDirectDownload = value;
					await this.plugin.saveSettings();
				})
			);
	}
}
