import { vi, describe, it, expect, beforeEach } from "vitest";

// Capture onChange callbacks installed by display() so tests can invoke them.
type ToggleCb = (value: boolean) => Promise<void>;
type TextCb = (value: string) => Promise<void>;
let toggleCallbacks: ToggleCb[] = [];
let textCallbacks: TextCb[] = [];

vi.mock("obsidian", () => {
  class PluginSettingTab {
    containerEl!: HTMLElement;
    constructor(_app: unknown, _plugin: unknown) {}
  }

  class Setting {
    constructor(_container: unknown) {}
    setName() { return this; }
    setHeading() { return this; }
    setDesc() { return this; }
    addToggle(build: (toggle: {
      setValue(v: boolean): typeof toggle;
      onChange(fn: ToggleCb): typeof toggle;
    }) => void) {
      let cb: ToggleCb | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t: any = { setValue: () => t, onChange: (fn: ToggleCb) => { cb = fn; return t; } };
      build(t);
      if (cb) toggleCallbacks.push(cb);
      return this;
    }
    addText(build: (text: {
      setPlaceholder(v: string): typeof text;
      setValue(v: string): typeof text;
      setDisabled(v: boolean): typeof text;
      onChange(fn: TextCb): typeof text;
    }) => void) {
      let cb: TextCb | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t: any = { setPlaceholder: () => t, setValue: () => t, setDisabled: () => t, onChange: (fn: TextCb) => { cb = fn; return t; } };
      build(t);
      if (cb) textCallbacks.push(cb);
      return this;
    }
  }

  return { PluginSettingTab, Setting, App: class {} };
});

import { PMCompassSettingTab, DEFAULT_SETTINGS } from "./settings";
import type { PMCompassSettings } from "./settings";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makePlugin(overrides: Partial<PMCompassSettings> = {}): any {
  const settings: PMCompassSettings = { ...DEFAULT_SETTINGS, ...overrides };
  return {
    settings,
    manifest: { version: "1.0.0" },
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };
}

describe("PMCompassSettingTab.display", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let plugin: any;
  let tab: PMCompassSettingTab;

  beforeEach(() => {
    toggleCallbacks = [];
    textCallbacks = [];
    plugin = makePlugin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tab = new PMCompassSettingTab({} as any, plugin);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tab as any).containerEl = { empty: vi.fn() } as unknown as HTMLElement;
    tab.display();
    // After display(): toggleCallbacks[0] = sync toggle
    //                  textCallbacks[0]   = projectsFolder
    //                  textCallbacks[1]   = dailyHabitsTag
  });

  describe("sync-obsidian-pm toggle", () => {
    it("updates syncObsidianPmSettings to the new value", async () => {
      await toggleCallbacks[0](false);
      expect(plugin.settings.syncObsidianPmSettings).toBe(false);
    });

    it("calls saveSettings", async () => {
      await toggleCallbacks[0](true);
      expect(plugin.saveSettings).toHaveBeenCalledOnce();
    });

    it("re-renders by calling display again after saving", async () => {
      const spy = vi.spyOn(tab, "display");
      await toggleCallbacks[0](false);
      expect(spy).toHaveBeenCalled();
    });
  });

  describe("projectsFolder text", () => {
    it("sets projectsFolder to the trimmed value", async () => {
      await textCallbacks[0]("  My Projects  ");
      expect(plugin.settings.projectsFolder).toBe("My Projects");
    });

    it("falls back to 'Projects' when the value is empty after trimming", async () => {
      await textCallbacks[0]("   ");
      expect(plugin.settings.projectsFolder).toBe("Projects");
    });

    it("calls saveSettings", async () => {
      await textCallbacks[0]("Custom");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe("dailyHabitsTag text", () => {
    it("sets dailyHabitsTag to the trimmed value", async () => {
      await textCallbacks[1]("weekly");
      expect(plugin.settings.dailyHabitsTag).toBe("weekly");
    });

    it("strips a leading # from the tag value", async () => {
      await textCallbacks[1]("#habits");
      expect(plugin.settings.dailyHabitsTag).toBe("habits");
    });

    it("falls back to 'daily' when the value is empty after trimming", async () => {
      await textCallbacks[1]("  ");
      expect(plugin.settings.dailyHabitsTag).toBe("daily");
    });

    it("calls saveSettings", async () => {
      await textCallbacks[1]("custom");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });
});
