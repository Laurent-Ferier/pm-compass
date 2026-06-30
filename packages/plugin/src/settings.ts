import { App, PluginSettingTab, Setting } from "obsidian";
import type PMCompassPlugin from "./main";

export interface PMCompassSettings {
  projectsFolder: string;
  syncObsidianPmSettings: boolean;
  panelConfig: { showActiveOnly: boolean };
  nodePositions: Record<string, { x: number; y: number }>;
  dailyHabitsTag: string;
  dashboardCollapsed: Record<string, boolean>;
  unclosedDaysBefore: number;
  unclosedDaysAfter: number;
}

export const DEFAULT_SETTINGS: PMCompassSettings = {
  projectsFolder: "Projects",
  syncObsidianPmSettings: true,
  panelConfig: { showActiveOnly: true },
  nodePositions: {},
  dailyHabitsTag: "daily",
  dashboardCollapsed: {},
  unclosedDaysBefore: 7,
  unclosedDaysAfter: 7,
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
    new Setting(containerEl)
      .setName(`PM Compass v${this.plugin.manifest.version}`)
      .setHeading();

    new Setting(containerEl)
      .setName("Project Manager integration")
      .setHeading();

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

    new Setting(containerEl)
      .setName("Daily Notes integration")
      .setHeading();

    new Setting(containerEl)
      .setName("Daily habits tag")
      .setDesc(
        "Only checklist items carrying this tag are shown in the Task Habits section of the Week Summary. Example: #daily",
      )
      .addText((text) =>
        text
          .setPlaceholder("daily")
          .setValue(this.plugin.settings.dailyHabitsTag)
          .onChange(async (value) => {
            this.plugin.settings.dailyHabitsTag = value.trim().replace(/^#/, "") || "daily";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Unclosed items — days before")
      .setDesc(
        "Number of past days to scan for unclosed checklist items in the dashboard (0 to disable).",
      )
      .addText((text) =>
        text
          .setPlaceholder("7")
          .setValue(String(this.plugin.settings.unclosedDaysBefore))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.unclosedDaysBefore = Number.isFinite(n) && n >= 0 ? n : 7;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Unclosed items — days after")
      .setDesc(
        "Number of upcoming days to scan for unclosed checklist items in the dashboard (0 to disable).",
      )
      .addText((text) =>
        text
          .setPlaceholder("7")
          .setValue(String(this.plugin.settings.unclosedDaysAfter))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.unclosedDaysAfter = Number.isFinite(n) && n >= 0 ? n : 7;
            await this.plugin.saveSettings();
          }),
      );
  }
}
