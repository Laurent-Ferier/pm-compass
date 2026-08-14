// Minimal stub so vitest can resolve the "obsidian" module.
// Test files use vi.mock("obsidian", factory) to supply their own implementations.

export class Plugin {
  app: unknown;
  constructor(app: unknown) { this.app = app; }
  async loadData() { return null; }
  async saveData(_data: unknown) {}
  registerView() {}
  addRibbonIcon() { return {}; }
  addCommand() {}
  addSettingTab() {}
}
export class PluginSettingTab {
  constructor(_app: unknown, _plugin: unknown) {}
}
export class Setting {
  constructor(_container: unknown) {}
  setName() { return this; }
  setHeading() { return this; }
  setDesc() { return this; }
  addToggle() { return this; }
  addText() { return this; }
}
export class ItemView {
  contentEl = {
    createDiv: () => ({}),
    createEl: () => ({}),
    createSpan: () => ({}),
    querySelector: () => null,
    empty: () => {},
  };
}
export class WorkspaceLeaf {}
export class TFile {
  path = "";
  extension = "";
  basename = "";
}
export class TFolder {
  children: unknown[] = [];
}
/** Keeps what was registered on it, so a test can run the handlers itself — see
 *  `src/ui/__testing__/keymap-app.ts`. */
export class Scope {
  parent?: Scope;
  handlers: { key: string | null; run: () => boolean | void }[] = [];
  constructor(parent?: Scope) { this.parent = parent; }
  register(_modifiers: unknown, key: string | null, run: () => boolean | void) {
    this.handlers.push({ key, run });
    return run;
  }
  unregister(_handler: unknown) {}
}
export const Platform = { isMobile: false };
export const normalizePath = (p: string) => p;
