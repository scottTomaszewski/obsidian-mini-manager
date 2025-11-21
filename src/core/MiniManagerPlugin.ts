import {Plugin, Notice} from 'obsidian';
import {
	MiniManagerSettings,
	DEFAULT_SETTINGS,
	MiniManagerSettingsTab
} from '../settings/MiniManagerSettings';

export default class MiniManagerPlugin extends Plugin {
	settings: MiniManagerSettings;

	async onload() {
		console.log('Loading Mini Manager plugin');

		// Initialize settings
		await this.loadSettings();

		// Check if ESV API token is set and show a notice if it's not
		// if (!this.settings.esvApiToken) {
		// 	new Notice('TODO.', 10000);
		// }

		// Register settings tab
		this.addSettingTab(new MiniManagerSettingsTab(this.app, this));
	}

	onunload() {
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
} 
