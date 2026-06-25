import { App, PluginSettingTab, Setting } from "obsidian";
import type PMCompassPlugin from "./main";

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
    containerEl.createEl("p", {
      text: "Settings coming soon.",
      cls: "setting-item-description",
    });
  }
}
