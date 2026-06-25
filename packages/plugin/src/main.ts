import { Plugin } from "obsidian";
import { PMCompassSettingTab } from "./settings";

export default class PMCompassPlugin extends Plugin {
  async onload(): Promise<void> {
    this.addSettingTab(new PMCompassSettingTab(this.app, this));
  }

  onunload(): void {}
}
