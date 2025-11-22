import {App, Notice, PluginSettingTab, Setting} from 'obsidian';
import MiniManagerPlugin from '../core/MiniManagerPlugin';

export interface MiniManagerSettings {
	mmfApiKey: string;
	downloadPath: string;
	downloadImages: boolean;
	downloadFiles: boolean;
	useDirectDownload: boolean;
	strictApiMode: boolean;
	maxRetries: number;
}

export const DEFAULT_SETTINGS: MiniManagerSettings = {
	mmfApiKey: '',
	downloadPath: 'MyMiniFactory',
	downloadImages: true,
	downloadFiles: true,
	useDirectDownload: false,
	strictApiMode: false,
	maxRetries: 2,
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
			
		new Setting(containerEl).setName('Advanced Settings').setHeading();
		
		new Setting(containerEl)
			.setName('Strict API Mode')
			.setDesc('If enabled, the plugin will fail when API errors occur. Disable to allow graceful fallbacks.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.strictApiMode)
				.onChange(async (value) => {
					this.plugin.settings.strictApiMode = value;
					await this.plugin.saveSettings();
				})
			);
			
		new Setting(containerEl)
			.setName('Max Retries')
			.setDesc('Number of times to retry API requests on transient errors.')
			.addSlider(slider => slider
				.setLimits(0, 5, 1)
				.setValue(this.plugin.settings.maxRetries)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.maxRetries = value;
					await this.plugin.saveSettings();
				})
			);
			
		// Add a test connection button
		new Setting(containerEl)
			.setName('Test API Connection')
			.setDesc('Click to test your API key and connection to MyMiniFactory')
			.addButton(button => button
				.setButtonText('Test Connection')
				.onClick(async () => {
					if (!this.plugin.settings.mmfApiKey) {
						new Notice('Please enter an API key first');
						return;
					}
					
					new Notice('Testing connection to MyMiniFactory API...');
					
					try {
						const isValid = await this.plugin.apiService.validateApiKey();
						if (isValid) {
							new Notice('✅ Connection successful! API key is valid.');
						} else {
							new Notice('❌ Connection failed. Please check your API key.');
						}
					} catch (error) {
						new Notice(`❌ Connection test failed: ${error.message}`);
					}
				})
			);
	}
}
