import { vi, describe, it, expect, beforeEach } from "vitest";

// Capture onChange callbacks installed by display() so tests can invoke them.
type ToggleCb = (value: boolean) => Promise<void>;
type TextCb = (value: string) => Promise<void>;
type ButtonCb = () => void | Promise<void>;
let toggleCallbacks: ToggleCb[] = [];
let textCallbacks: TextCb[] = [];
// Each row's buttons/extraButtons, in display order (one entry per Setting that has any).
let buttonCallbacks: ButtonCb[][] = [];
let extraButtonCallbacks: ButtonCb[][] = [];

vi.mock("obsidian", () => {
  class PluginSettingTab {
    containerEl!: HTMLElement;
    constructor(_app: unknown, _plugin: unknown) {}
  }

  class Setting {
    private rowButtons: ButtonCb[] = [];
    private rowExtraButtons: ButtonCb[] = [];
    settingEl = { addClass: () => {} };

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
    addButton(build: (btn: {
      setButtonText(v: string): typeof btn;
      setCta(): typeof btn;
      setDisabled(v: boolean): typeof btn;
      onClick(fn: ButtonCb): typeof btn;
    }) => void) {
      let cb: ButtonCb | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {
        setButtonText: () => b,
        setCta: () => b,
        setDisabled: () => b,
        onClick: (fn: ButtonCb) => { cb = fn; return b; },
      };
      build(b);
      const isFirstForRow = this.rowButtons.length === 0;
      if (cb) this.rowButtons.push(cb);
      if (isFirstForRow && this.rowButtons.length) buttonCallbacks.push(this.rowButtons);
      return this;
    }
    addExtraButton(build: (btn: {
      setIcon(v: string): typeof btn;
      setTooltip(v: string): typeof btn;
      setDisabled(v: boolean): typeof btn;
      onClick(fn: ButtonCb): typeof btn;
    }) => void) {
      let cb: ButtonCb | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {
        setIcon: () => b,
        setTooltip: () => b,
        setDisabled: () => b,
        onClick: (fn: ButtonCb) => { cb = fn; return b; },
      };
      build(b);
      const isFirstForRow = this.rowExtraButtons.length === 0;
      if (cb) this.rowExtraButtons.push(cb);
      if (isFirstForRow && this.rowExtraButtons.length) extraButtonCallbacks.push(this.rowExtraButtons);
      return this;
    }
  }

  return { PluginSettingTab, Setting, App: class {} };
});

vi.mock("./recurring-task-modal", () => ({
  RecurringTaskModal: vi.fn(),
}));

import { PMCompassSettingTab } from "./settings-tab";
import { DEFAULT_SETTINGS } from "../model/settings";
import type { PMCompassSettings } from "../model/settings";
import { ALL_WEEKDAYS } from "../model/recurring-task";

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
    buttonCallbacks = [];
    extraButtonCallbacks = [];
    plugin = makePlugin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tab = new PMCompassSettingTab({} as any, plugin);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tab as any).containerEl = { empty: vi.fn() } as unknown as HTMLElement;
    tab.display();
    // After display(): toggleCallbacks[0] = sync toggle
    //                  textCallbacks[0]   = projectsFolder
    //                  textCallbacks[1]   = inboxFilePath
    //                  textCallbacks[2]   = inboxStaleAfterDays
    //                  textCallbacks[3]   = unclosedDaysBefore
    //                  textCallbacks[4]   = unclosedDaysAfter
    //                  textCallbacks[5]   = recurringTasksHeading
    //                  textCallbacks[6]   = dailyHabitsTag
    //                  buttonCallbacks[last] = "+ Add habit" (no rows since recurringTasks is empty)
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

  describe("inboxFilePath text", () => {
    it("sets inboxFilePath to the trimmed value", async () => {
      await textCallbacks[1]("  Daily/Inbox.md  ");
      expect(plugin.settings.inboxFilePath).toBe("Daily/Inbox.md");
    });

    it("accepts an empty string (uses default path resolution)", async () => {
      await textCallbacks[1]("");
      expect(plugin.settings.inboxFilePath).toBe("");
    });

    it("calls saveSettings", async () => {
      await textCallbacks[1]("Daily/Inbox.md");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe("inboxStaleAfterDays text", () => {
    it("sets inboxStaleAfterDays to the parsed integer", async () => {
      await textCallbacks[2]("14");
      expect(plugin.settings.inboxStaleAfterDays).toBe(14);
    });

    it("accepts 0 to disable", async () => {
      await textCallbacks[2]("0");
      expect(plugin.settings.inboxStaleAfterDays).toBe(0);
    });

    it("falls back to 7 when the value is not a valid number", async () => {
      await textCallbacks[2]("abc");
      expect(plugin.settings.inboxStaleAfterDays).toBe(7);
    });

    it("falls back to 7 when the value is negative", async () => {
      await textCallbacks[2]("-1");
      expect(plugin.settings.inboxStaleAfterDays).toBe(7);
    });

    it("calls saveSettings", async () => {
      await textCallbacks[2]("10");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe("unclosedDaysBefore text", () => {
    it("sets unclosedDaysBefore to the parsed integer", async () => {
      await textCallbacks[3]("3");
      expect(plugin.settings.unclosedDaysBefore).toBe(3);
    });

    it("accepts 0 to disable", async () => {
      await textCallbacks[3]("0");
      expect(plugin.settings.unclosedDaysBefore).toBe(0);
    });

    it("falls back to 7 when the value is not a valid number", async () => {
      await textCallbacks[3]("abc");
      expect(plugin.settings.unclosedDaysBefore).toBe(7);
    });

    it("falls back to 7 when the value is negative", async () => {
      await textCallbacks[3]("-1");
      expect(plugin.settings.unclosedDaysBefore).toBe(7);
    });

    it("calls saveSettings", async () => {
      await textCallbacks[3]("5");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe("unclosedDaysAfter text", () => {
    it("sets unclosedDaysAfter to the parsed integer", async () => {
      await textCallbacks[4]("14");
      expect(plugin.settings.unclosedDaysAfter).toBe(14);
    });

    it("accepts 0 to disable", async () => {
      await textCallbacks[4]("0");
      expect(plugin.settings.unclosedDaysAfter).toBe(0);
    });

    it("falls back to 7 when the value is not a valid number", async () => {
      await textCallbacks[4]("");
      expect(plugin.settings.unclosedDaysAfter).toBe(7);
    });

    it("falls back to 7 when the value is negative", async () => {
      await textCallbacks[4]("-2");
      expect(plugin.settings.unclosedDaysAfter).toBe(7);
    });

    it("calls saveSettings", async () => {
      await textCallbacks[4]("3");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe("recurringTasksHeading text", () => {
    it("sets recurringTasksHeading to the trimmed value", async () => {
      await textCallbacks[5]("  # Habits  ");
      expect(plugin.settings.recurringTasksHeading).toBe("# Habits");
    });

    it("falls back to '# Routine' when the value is empty after trimming", async () => {
      await textCallbacks[5]("   ");
      expect(plugin.settings.recurringTasksHeading).toBe("# Routine");
    });

    it("calls saveSettings", async () => {
      await textCallbacks[5]("# Habits");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe("dailyHabitsTag text", () => {
    it("sets dailyHabitsTag to the trimmed value", async () => {
      await textCallbacks[6]("weekly");
      expect(plugin.settings.dailyHabitsTag).toBe("weekly");
    });

    it("strips a leading # from the tag value", async () => {
      await textCallbacks[6]("#habits");
      expect(plugin.settings.dailyHabitsTag).toBe("habits");
    });

    it("falls back to 'daily' when the value is empty after trimming", async () => {
      await textCallbacks[6]("  ");
      expect(plugin.settings.dailyHabitsTag).toBe("daily");
    });

    it("calls saveSettings", async () => {
      await textCallbacks[6]("custom");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe("scroll position", () => {
    it("restores containerEl.scrollTop after a re-render triggered by a settings change", async () => {
      (tab as any).containerEl.scrollTop = 250;
      await toggleCallbacks[0](false); // triggers this.display() internally
      expect((tab as any).containerEl.scrollTop).toBe(250);
    });
  });

  describe("recurring habits — add", () => {
    it("appends a new active habit scheduled every day and re-renders", async () => {
      const addHabitCb = buttonCallbacks[buttonCallbacks.length - 1][0];
      await addHabitCb();
      expect(plugin.settings.recurringTasks).toHaveLength(1);
      expect(plugin.settings.recurringTasks[0]).toMatchObject({
        title: "New habit",
        weekdays: ALL_WEEKDAYS,
        active: true,
        order: 0,
      });
      expect(plugin.saveSettings).toHaveBeenCalled();
    });

    it("assigns increasing order values to successive habits", async () => {
      const addHabitCb = () => buttonCallbacks[buttonCallbacks.length - 1][0]();
      await addHabitCb();
      await addHabitCb();
      expect(plugin.settings.recurringTasks.map((d: { order: number }) => d.order)).toEqual([0, 1]);
    });
  });
});

describe("PMCompassSettingTab — recurring habit rows", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let plugin: any;
  let tab: PMCompassSettingTab;

  function renderWithHabits() {
    toggleCallbacks = [];
    textCallbacks = [];
    buttonCallbacks = [];
    extraButtonCallbacks = [];
    plugin = makePlugin({
      recurringTasks: [
        {
          id: "a", title: "Habit A", weekdays: 0b0011111,
          order: 0, active: true, createdAt: "2026-01-01", detail: "",
        },
        {
          id: "b", title: "Habit B", weekdays: ALL_WEEKDAYS,
          order: 1, active: false, createdAt: "2026-01-01", detail: "",
        },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tab = new PMCompassSettingTab({} as any, plugin);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tab as any).containerEl = { empty: vi.fn() } as unknown as HTMLElement;
    tab.display();
  }

  beforeEach(() => {
    renderWithHabits();
    // toggleCallbacks[0] = "sync obsidian-pm" toggle (rendered before the habits section)
    // toggleCallbacks[1] = active toggle for Habit A
    // toggleCallbacks[2] = active toggle for Habit B
    // Row buttons: buttonCallbacks[0] = 7 weekday toggles for Habit A
    //              buttonCallbacks[1] = 7 weekday toggles for Habit B
    //              buttonCallbacks[2] = "+ Add habit"
    // Row extra buttons: extraButtonCallbacks[0] = [up, down, edit, delete] for Habit A
    //                    extraButtonCallbacks[1] = [up, down, edit, delete] for Habit B
  });

  it("toggles a weekday bit off when its button is clicked", async () => {
    const habitA = plugin.settings.recurringTasks[0];
    const mondayCb = buttonCallbacks[0][0];
    await mondayCb();
    expect(habitA.weekdays & 1).toBe(0);
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it("toggles active off via the toggle control", async () => {
    const habitA = plugin.settings.recurringTasks[0];
    await toggleCallbacks[1](false);
    expect(habitA.active).toBe(false);
  });

  it("swaps order with the previous row when 'move up' is clicked on the second row", async () => {
    const [habitA, habitB] = plugin.settings.recurringTasks;
    const moveUpForB = extraButtonCallbacks[1][0];
    await moveUpForB();
    expect(habitA.order).toBe(1);
    expect(habitB.order).toBe(0);
  });

  it("swaps order with the next row when 'move down' is clicked on the first row", async () => {
    const [habitA, habitB] = plugin.settings.recurringTasks;
    const moveDownForA = extraButtonCallbacks[0][1];
    await moveDownForA();
    expect(habitA.order).toBe(1);
    expect(habitB.order).toBe(0);
  });

  it("removes the definition when delete is clicked", async () => {
    const deleteForA = extraButtonCallbacks[0][3];
    await deleteForA();
    expect(plugin.settings.recurringTasks.map((d: { id: string }) => d.id)).toEqual(["b"]);
  });
});
