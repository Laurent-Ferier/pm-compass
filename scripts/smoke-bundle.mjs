#!/usr/bin/env node
//
// Loads the built main.js and puts the plugin through onload, asserting it still registers
// everything it should.
//
//   node scripts/smoke-bundle.mjs [<bundle-path>]   (defaults to ./main.js)
//
// The vitest suite runs against src/, so it never sees the bundle that is actually shipped.
// A release is built by plain `pnpm build` (minified, no sourcemap), and a mangling that
// broke the plugin would pass all of vitest and reach users. This is the check that covers
// that gap, which is why release.yml runs it between the build and the attestation.
//
// It asserts behaviour that survives minification — registered view types, command ids —
// rather than class or function names, which do not.

import { createRequire } from "module";
import Module from "module";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import assert from "assert";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = resolve(root, process.argv[2] ?? "main.js");

const bundle = readFileSync(bundlePath, "utf8");
const bundleKb = bundle.length / 1024;
console.log(`Bundle: ${bundleKb.toFixed(0)} KB`);

// Guard the premise: everything below would pass just as happily on a --dev bundle, which
// would leave the shipped one unchecked. A dev build carries a sourcemap and is ~8x larger.
assert(
  !bundle.includes("//# sourceMappingURL"),
  "bundle carries a sourcemap — this is a --dev build, not the one a release ships",
);
assert(bundleKb < 1500, `bundle is ${bundleKb.toFixed(0)} KB — too large to be minified`);

// "obsidian" is external in the build, so requiring the bundle needs it supplied here.
class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
    this.registeredViews = [];
    this.ribbonIcons = [];
    this.commands = [];
    this.settingTabs = [];
    this.events = [];
  }
  async loadData() { return null; }
  async saveData() {}
  registerView(type, factory) { this.registeredViews.push({ type, factory }); }
  addRibbonIcon(icon, title) { this.ribbonIcons.push({ icon, title }); return {}; }
  addCommand(cmd) { this.commands.push(cmd); return cmd; }
  addSettingTab(tab) { this.settingTabs.push(tab); }
  registerEvent(ref) { this.events.push(ref); }
  registerDomEvent() {}
  registerInterval() {}
}

class Component {
  load() {} unload() {} onload() {} onunload() {}
  addChild(c) { return c; } removeChild(c) { return c; }
  register() {} registerEvent() {} registerDomEvent() {} registerInterval() {}
}

const obsidianStub = {
  Plugin,
  Component,
  PluginSettingTab: class { constructor(app, plugin) { this.app = app; this.plugin = plugin; } },
  Setting: class {
    setName() { return this; } setHeading() { return this; } setDesc() { return this; }
    addToggle() { return this; } addText() { return this; } addDropdown() { return this; }
    addButton() { return this; } addSlider() { return this; } addTextArea() { return this; }
  },
  ItemView: class { constructor(leaf) { this.leaf = leaf; } },
  WorkspaceLeaf: class {},
  Modal: class { constructor(app) { this.app = app; } },
  Notice: class {},
  TFile: class { constructor() { this.path = ""; this.extension = ""; this.basename = ""; } },
  TFolder: class { constructor() { this.children = []; } },
  TAbstractFile: class {},
  MarkdownRenderer: { render: async () => {} },
  normalizePath: (p) => p,
  setIcon: () => {},
  setTooltip: () => {},
  debounce: (fn) => fn,
  moment: () => ({ format: () => "" }),
  requestUrl: async () => ({ json: {} }),
  Menu: class { addItem() { return this; } showAtMouseEvent() {} },
  Platform: { isMobile: false, isDesktop: true },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return obsidianStub;
  return realLoad.call(this, request, parent, isMain);
};

// Cytoscape reaches for the DOM at import time; a couple of globals keep that from throwing.
globalThis.window ??= globalThis;
globalThis.navigator ??= { userAgent: "node" };

const require = createRequire(import.meta.url);
const exported = require(bundlePath);

Module._load = realLoad;

const PluginClass = exported.default;
assert(typeof PluginClass === "function", "bundle has no default export class");
assert(PluginClass.prototype instanceof Plugin, "default export does not extend Plugin");

// A vault that answers every read the way an empty one would.
const app = {
  vault: {
    configDir: ".obsidian",
    adapter: { read: async () => { throw new Error("missing"); }, exists: async () => false },
    on: () => ({}),
    getMarkdownFiles: () => [],
    getAbstractFileByPath: () => null,
  },
  workspace: { on: () => ({}), getLeavesOfType: () => [] },
  metadataCache: { on: () => ({}), getFileCache: () => null },
};

const plugin = new PluginClass(app, { id: "pm-compass", version: "0.0.0" });
await plugin.onload();

const viewTypes = plugin.registeredViews.map((v) => v.type).sort();
const commandIds = plugin.commands.map((c) => c.id).sort();

const expectedViews = ["pm-compass-dashboard", "pm-compass-task-graph"];
const expectedCommands = [
  "backfill-recurring-habits", "open-dashboard", "open-task-graph", "repair-project-listings",
].sort();

assert.deepStrictEqual(viewTypes, expectedViews, `views: got ${viewTypes}`);
assert.deepStrictEqual(commandIds, expectedCommands, `commands: got ${commandIds}`);
assert.strictEqual(plugin.ribbonIcons.length, 2, "expected 2 ribbon icons");
assert.strictEqual(plugin.settingTabs.length, 1, "expected 1 setting tab");
assert(plugin.events.length > 0, "expected vault/workspace events to be registered");

// The views must be constructible: a mangled base class would only show up here.
for (const { type, factory } of plugin.registeredViews) {
  const view = factory({});
  assert(view, `view factory for ${type} returned nothing`);
  assert.strictEqual(view.getViewType(), type, `getViewType() mismatch for ${type}`);
}

console.log(`✓ views:    ${viewTypes.join(", ")}`);
console.log(`✓ commands: ${commandIds.join(", ")}`);
console.log(`✓ ${plugin.ribbonIcons.length} ribbon icons, ${plugin.settingTabs.length} setting tab, ${plugin.events.length} events`);
console.log("Bundle smoke test passed.");
