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

import { PMCompassSettingTab } from "./settings-tab";
import { DEFAULT_SETTINGS } from "../model/settings";
import type { PMCompassSettings } from "../model/settings";

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
    //                  textCallbacks[2]   = inboxFilePath
    //                  textCallbacks[3]   = unclosedDaysBefore
    //                  textCallbacks[4]   = unclosedDaysAfter
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

  describe("inboxFilePath text", () => {
    it("sets inboxFilePath to the trimmed value", async () => {
      await textCallbacks[2]("  Daily/Inbox.md  ");
      expect(plugin.settings.inboxFilePath).toBe("Daily/Inbox.md");
    });

    it("accepts an empty string (uses default path resolution)", async () => {
      await textCallbacks[2]("");
      expect(plugin.settings.inboxFilePath).toBe("");
    });

    it("calls saveSettings", async () => {
      await textCallbacks[2]("Daily/Inbox.md");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe("inboxStaleAfterDays text", () => {
    it("sets inboxStaleAfterDays to the parsed integer", async () => {
      await textCallbacks[3]("14");
      expect(plugin.settings.inboxStaleAfterDays).toBe(14);
    });

    it("accepts 0 to disable", async () => {
      await textCallbacks[3]("0");
      expect(plugin.settings.inboxStaleAfterDays).toBe(0);
    });

    it("falls back to 7 when the value is not a valid number", async () => {
      await textCallbacks[3]("abc");
      expect(plugin.settings.inboxStaleAfterDays).toBe(7);
    });

    it("falls back to 7 when the value is negative", async () => {
      await textCallbacks[3]("-1");
      expect(plugin.settings.inboxStaleAfterDays).toBe(7);
    });

    it("calls saveSettings", async () => {
      await textCallbacks[3]("10");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe("unclosedDaysBefore text", () => {
    it("sets unclosedDaysBefore to the parsed integer", async () => {
      await textCallbacks[4]("3");
      expect(plugin.settings.unclosedDaysBefore).toBe(3);
    });

    it("accepts 0 to disable", async () => {
      await textCallbacks[4]("0");
      expect(plugin.settings.unclosedDaysBefore).toBe(0);
    });

    it("falls back to 7 when the value is not a valid number", async () => {
      await textCallbacks[4]("abc");
      expect(plugin.settings.unclosedDaysBefore).toBe(7);
    });

    it("falls back to 7 when the value is negative", async () => {
      await textCallbacks[4]("-1");
      expect(plugin.settings.unclosedDaysBefore).toBe(7);
    });

    it("calls saveSettings", async () => {
      await textCallbacks[4]("5");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe("unclosedDaysAfter text", () => {
    it("sets unclosedDaysAfter to the parsed integer", async () => {
      await textCallbacks[5]("14");
      expect(plugin.settings.unclosedDaysAfter).toBe(14);
    });

    it("accepts 0 to disable", async () => {
      await textCallbacks[5]("0");
      expect(plugin.settings.unclosedDaysAfter).toBe(0);
    });

    it("falls back to 7 when the value is not a valid number", async () => {
      await textCallbacks[5]("");
      expect(plugin.settings.unclosedDaysAfter).toBe(7);
    });

    it("falls back to 7 when the value is negative", async () => {
      await textCallbacks[5]("-2");
      expect(plugin.settings.unclosedDaysAfter).toBe(7);
    });

    it("calls saveSettings", async () => {
      await textCallbacks[5]("3");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });
});
