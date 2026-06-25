import { App, PluginSettingTab, Setting } from "obsidian";
import type PMCompassPlugin from "./main";

export interface PMCompassSettings {
  projectsFolder: string;
  syncObsidianPmSettings: boolean;
  panelConfig: { showActiveOnly: boolean };
}

export const DEFAULT_SETTINGS: PMCompassSettings = {
  projectsFolder: "Projects",
  syncObsidianPmSettings: true,
  panelConfig: { showActiveOnly: true },
};

export class PMCompassSettingTab extends PluginSettingTab {
  plugin: PMCompassPlugin;

  constructor(app: App, plugin: PMCompassPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("PM Compass").setHeading();

    new Setting(containerEl)
      .setName("Automatically synchronize obsidian-pm parameters")
      .setDesc(
        "When enabled, the projects folder is read from obsidian-pm settings at startup.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncObsidianPmSettings)
          .onChange(async (value) => {
            this.plugin.settings.syncObsidianPmSettings = value;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("Projects folder")
      .setDesc(
        "Vault-relative path to the folder containing obsidian-pm project files.",
      )
      .addText((text) =>
        text
          .setPlaceholder("Projects")
          .setValue(this.plugin.settings.projectsFolder)
          .setDisabled(this.plugin.settings.syncObsidianPmSettings)
          .onChange(async (value) => {
            this.plugin.settings.projectsFolder = value.trim() || "Projects";
            await this.plugin.saveSettings();
          }),
      );
  }
}
