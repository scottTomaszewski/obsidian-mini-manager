import {App, Notice, PluginSettingTab, Setting} from 'obsidian';
import MiniManagerPlugin from '../core/MiniManagerPlugin';

export interface MiniManagerSettings {
	displayInlineVerses: boolean;
}

export const DEFAULT_SETTINGS: MiniManagerSettings = {
	displayInlineVerses: true,
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

		new Setting(containerEl).setName('Display Customization').setHeading();

		new Setting(containerEl)
			.setName('Display Inline Verses')
			.setDesc('Enable rendering of inline Bible references (in `code blocks`).')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.displayInlineVerses)
				.onChange(async (value) => {
					this.plugin.settings.displayInlineVerses = value;
					await this.plugin.saveSettings();
				})
			);
	}
}
