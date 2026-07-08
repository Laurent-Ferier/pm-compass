// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

type ToggleCb = (value: boolean) => Promise<void>;
type ButtonCb = () => void | Promise<void>;

// Minimal Obsidian-style DOM helpers, same pattern used elsewhere in this codebase's tests,
// needed for the real `nameEl`/`settingEl` elements below (`createEl`/`addClass`/`empty`).
function installObsidianDOMPolyfills() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const htmlProto = HTMLElement.prototype as any;
  type CreateElOpts = { cls?: string; text?: string; type?: string; attr?: Record<string, string> };
  htmlProto.createEl = function (this: Element, tag: string, opts?: CreateElOpts) {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    if (opts?.text) el.textContent = opts.text;
    if (opts?.type) (el as HTMLInputElement).type = opts.type;
    if (opts?.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
    this.appendChild(el);
    return el;
  };
  htmlProto.addClass = function (this: HTMLElement, cls: string) { this.classList.add(cls); };
  htmlProto.empty = function (this: HTMLElement) { this.innerHTML = ""; };
}

beforeAll(() => {
  installObsidianDOMPolyfills();
});

// Fake `Setting` instance handed to a `type: 'render'` definition's `render(setting, group)`
// callback, mirroring the real API surface `settings-tab.ts` uses on it (settingEl/nameEl plus
// addButton/addToggle/addExtraButton). Real DOM elements are used for settingEl/nameEl so the
// inline-rename input (created via `nameEl.createEl`) gets genuine focus/blur/click behavior.
class FakeSetting {
  settingEl: HTMLElement;
  nameEl: HTMLElement;
  private rowButtons: ButtonCb[] = [];
  private rowExtraButtons: ButtonCb[] = [];

  constructor() {
    this.settingEl = document.createElement("div");
    this.nameEl = document.createElement("div");
    this.settingEl.appendChild(this.nameEl);
    document.body.appendChild(this.settingEl);
  }

  addToggle(build: (toggle: {
    setValue(v: boolean): typeof toggle;
    onChange(fn: ToggleCb): typeof toggle;
  }) => void) {
    let cb: ToggleCb | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t: any = { setValue: () => t, onChange: (fn: ToggleCb) => { cb = fn; return t; } };
    build(t);
    if (cb) this.toggleCallbacks.push(cb);
    return this;
  }

  addButton(build: (btn: {
    setButtonText(v: string): typeof btn;
    setCta(): typeof btn;
    onClick(fn: ButtonCb): typeof btn;
  }) => void) {
    let cb: ButtonCb | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = { setButtonText: () => b, setCta: () => b, onClick: (fn: ButtonCb) => { cb = fn; return b; } };
    build(b);
    if (cb) this.rowButtons.push(cb);
    return this;
  }

  addExtraButton(build: (btn: {
    setIcon(v: string): typeof btn;
    setTooltip(v: string): typeof btn;
    onClick(fn: ButtonCb): typeof btn;
  }) => void) {
    let cb: ButtonCb | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = { setIcon: () => b, setTooltip: () => b, onClick: (fn: ButtonCb) => { cb = fn; return b; } };
    build(b);
    if (cb) this.rowExtraButtons.push(cb);
    return this;
  }

  toggleCallbacks: ToggleCb[] = [];
  get weekdayCallbacks(): ButtonCb[] { return this.rowButtons; }
  get editCallback(): ButtonCb { return this.rowExtraButtons[0]; }
}

vi.mock("obsidian", () => {
  class PluginSettingTab {
    app: unknown;
    containerEl!: HTMLElement;
    update = vi.fn();
    refreshDomState = vi.fn();
    constructor(app: unknown, _plugin: unknown) {
      this.app = app;
    }
  }
  // Only used as a type by settings-tab.ts (the framework constructs real `Setting`s and
  // passes them into `render` callbacks) — a bare stand-in is enough to satisfy the import.
  class Setting {}
  return { PluginSettingTab, Setting, App: class {} };
});

type RecurringModalResult = { title: string; detail: string };
const { recurringModalInstances } = vi.hoisted(() => ({
  recurringModalInstances: [] as {
    app: unknown;
    def: unknown;
    onSubmit: (result: RecurringModalResult) => Promise<void>;
    open: () => void;
  }[],
}));

vi.mock("./recurring-task-modal", () => ({
  RecurringTaskModal: class {
    open = vi.fn();
    constructor(
      public app: unknown,
      public def: unknown,
      public onSubmit: (result: RecurringModalResult) => Promise<void>,
    ) {
      recurringModalInstances.push(this);
    }
  },
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findGroup(items: any[], heading: string): any {
  return items.find((i) => i.type === "group" && i.heading === heading);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findByName(items: any[], name: string): any {
  return items.find((i) => i.name === name);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findList(items: any[]): any {
  return items.find((i) => i.type === "list");
}

describe("PMCompassSettingTab.getSettingDefinitions structure", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let plugin: any;
  let tab: PMCompassSettingTab;

  beforeEach(() => {
    plugin = makePlugin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tab = new PMCompassSettingTab({} as any, plugin);
  });

  it("groups project manager integration settings under their heading", () => {
    const items = tab.getSettingDefinitions();
    const group = findGroup(items, "Project Manager integration");
    expect(group).toBeDefined();
    expect(findByName(group.items, "Automatically synchronize obsidian-pm parameters").control).toMatchObject({
      type: "toggle",
      key: "syncObsidianPmSettings",
    });
    expect(findByName(group.items, "Projects folder").control).toMatchObject({
      type: "text",
      key: "projectsFolder",
    });
  });

  it("disables the projects folder control when sync is enabled", () => {
    plugin.settings.syncObsidianPmSettings = true;
    const items = tab.getSettingDefinitions();
    const group = findGroup(items, "Project Manager integration");
    const control = findByName(group.items, "Projects folder").control;
    expect(control.disabled()).toBe(true);

    plugin.settings.syncObsidianPmSettings = false;
    expect(control.disabled()).toBe(false);
  });

  it("groups daily notes integration settings under their heading", () => {
    const items = tab.getSettingDefinitions();
    const group = findGroup(items, "Daily Notes integration");
    expect(group).toBeDefined();
    for (const name of [
      "Inbox file",
      "Inbox — stale task threshold (days)",
      "Unclosed items — days before",
      "Unclosed items — days after",
      "Small task planning window (weeks ahead)",
      "Scheduled task heading",
    ]) {
      expect(findByName(group.items, name)).toBeDefined();
    }
  });

  it("gives numeric controls a non-negative validator and min:0", () => {
    const items = tab.getSettingDefinitions();
    const group = findGroup(items, "Daily Notes integration");
    for (const name of [
      "Inbox — stale task threshold (days)",
      "Unclosed items — days before",
      "Unclosed items — days after",
      "Small task planning window (weeks ahead)",
    ]) {
      const control = findByName(group.items, name).control;
      expect(control.type).toBe("number");
      expect(control.min).toBe(0);
      expect(control.validate(5)).toBeUndefined();
      expect(control.validate(-1)).toEqual(expect.any(String));
      expect(control.validate(NaN)).toEqual(expect.any(String));
    }
  });

  it("groups recurring habit heading/tag settings under their heading", () => {
    const items = tab.getSettingDefinitions();
    const group = findGroup(items, "Recurring daily habits");
    expect(group).toBeDefined();
    expect(findByName(group.items, "Habits section heading").control).toMatchObject({
      type: "text",
      key: "recurringTasksHeading",
    });
    expect(findByName(group.items, "Daily habits tag").control).toMatchObject({
      type: "text",
      key: "dailyHabitsTag",
    });
  });

  it("exposes the recurring task rows as a top-level list", () => {
    const items = tab.getSettingDefinitions();
    const list = findList(items);
    expect(list).toBeDefined();
    expect(list.addItem.name).toBe("Add habit");
  });
});

describe("PMCompassSettingTab getControlValue/setControlValue", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let plugin: any;
  let tab: PMCompassSettingTab;

  beforeEach(() => {
    plugin = makePlugin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tab = new PMCompassSettingTab({} as any, plugin);
  });

  describe("syncObsidianPmSettings", () => {
    it("reads the current value", () => {
      plugin.settings.syncObsidianPmSettings = true;
      expect(tab.getControlValue("syncObsidianPmSettings")).toBe(true);
    });

    it("updates the value, saves, and refreshes dom state", async () => {
      await tab.setControlValue("syncObsidianPmSettings", false);
      expect(plugin.settings.syncObsidianPmSettings).toBe(false);
      expect(plugin.saveSettings).toHaveBeenCalledOnce();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((tab as any).refreshDomState).toHaveBeenCalled();
    });
  });

  describe("projectsFolder", () => {
    it("sets the trimmed value", async () => {
      await tab.setControlValue("projectsFolder", "  My Projects  ");
      expect(plugin.settings.projectsFolder).toBe("My Projects");
    });

    it("falls back to 'Projects' when empty after trimming", async () => {
      await tab.setControlValue("projectsFolder", "   ");
      expect(plugin.settings.projectsFolder).toBe("Projects");
    });

    it("calls saveSettings", async () => {
      await tab.setControlValue("projectsFolder", "Custom");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe("inboxFilePath", () => {
    it("sets the trimmed value", async () => {
      await tab.setControlValue("inboxFilePath", "  Daily/Inbox.md  ");
      expect(plugin.settings.inboxFilePath).toBe("Daily/Inbox.md");
    });

    it("accepts an empty string", async () => {
      await tab.setControlValue("inboxFilePath", "");
      expect(plugin.settings.inboxFilePath).toBe("");
    });
  });

  describe("numeric settings", () => {
    it.each([
      ["inboxStaleAfterDays"],
      ["unclosedDaysBefore"],
      ["unclosedDaysAfter"],
      ["smallTaskMaxWeeksAhead"],
    ] as const)("persists %s as-is (validation happens via the control's validate)", async (key) => {
      await tab.setControlValue(key, 14);
      expect(plugin.settings[key]).toBe(14);
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe("dailyTasksHeading", () => {
    it("sets the trimmed value", async () => {
      await tab.setControlValue("dailyTasksHeading", "  # To Do  ");
      expect(plugin.settings.dailyTasksHeading).toBe("# To Do");
    });

    it("falls back to '# Tasks' when empty after trimming", async () => {
      await tab.setControlValue("dailyTasksHeading", "   ");
      expect(plugin.settings.dailyTasksHeading).toBe("# Tasks");
    });
  });

  describe("recurringTasksHeading", () => {
    it("sets the trimmed value", async () => {
      await tab.setControlValue("recurringTasksHeading", "  # Habits  ");
      expect(plugin.settings.recurringTasksHeading).toBe("# Habits");
    });

    it("falls back to '# Routine' when empty after trimming", async () => {
      await tab.setControlValue("recurringTasksHeading", "   ");
      expect(plugin.settings.recurringTasksHeading).toBe("# Routine");
    });
  });

  describe("dailyHabitsTag", () => {
    it("sets the trimmed value", async () => {
      await tab.setControlValue("dailyHabitsTag", "weekly");
      expect(plugin.settings.dailyHabitsTag).toBe("weekly");
    });

    it("strips a leading #", async () => {
      await tab.setControlValue("dailyHabitsTag", "#habits");
      expect(plugin.settings.dailyHabitsTag).toBe("habits");
    });

    it("falls back to 'daily' when empty after trimming", async () => {
      await tab.setControlValue("dailyHabitsTag", "  ");
      expect(plugin.settings.dailyHabitsTag).toBe("daily");
    });
  });
});

describe("PMCompassSettingTab — recurring habits list", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let plugin: any;
  let tab: PMCompassSettingTab;

  beforeEach(() => {
    plugin = makePlugin({
      recurringTasks: [
        { id: "a", title: "Habit A", weekdays: 0b0011111, order: 0, active: true, createdAt: "2026-01-01", detail: "" },
        { id: "b", title: "Habit B", weekdays: ALL_WEEKDAYS, order: 1, active: false, createdAt: "2026-01-01", detail: "" },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tab = new PMCompassSettingTab({} as any, plugin);
  });

  it("adds a new active habit scheduled every day, ordered after existing ones", async () => {
    const list = findList(tab.getSettingDefinitions());
    await list.addItem.action(document.createElement("div"));
    expect(plugin.settings.recurringTasks).toHaveLength(3);
    expect(plugin.settings.recurringTasks[2]).toMatchObject({
      title: "New habit",
      weekdays: ALL_WEEKDAYS,
      active: true,
      order: 2,
    });
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it("reorders by splicing and reassigning order for every item", async () => {
    const list = findList(tab.getSettingDefinitions());
    // Move "Habit B" (index 1) to index 0.
    await list.onReorder(1, 0);
    const [habitA, habitB] = plugin.settings.recurringTasks;
    expect(habitB.order).toBe(0);
    expect(habitA.order).toBe(1);
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it("deletes the definition at the given index", async () => {
    const list = findList(tab.getSettingDefinitions());
    await list.onDelete(0);
    expect(plugin.settings.recurringTasks.map((d: { id: string }) => d.id)).toEqual(["b"]);
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it("renders one item per habit, sorted by order, with the active state in its desc", () => {
    const list = findList(tab.getSettingDefinitions());
    expect(list.items).toHaveLength(2);
    expect(list.items[0]).toMatchObject({ name: "Habit A", desc: "" });
    expect(list.items[1]).toMatchObject({ name: "Habit B", desc: "(inactive)" });
  });
});

describe("PMCompassSettingTab — recurring habit row rendering", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let plugin: any;
  let tab: PMCompassSettingTab;
  let fakeSetting: FakeSetting;

  function renderHabitA() {
    document.body.innerHTML = "";
    recurringModalInstances.length = 0;
    plugin = makePlugin({
      recurringTasks: [
        { id: "a", title: "Habit A", weekdays: 0b0011111, order: 0, active: true, createdAt: "2026-01-01", detail: "" },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tab = new PMCompassSettingTab({} as any, plugin);
    const list = findList(tab.getSettingDefinitions());
    fakeSetting = new FakeSetting();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    list.items[0].render(fakeSetting as any, {} as any);
  }

  beforeEach(() => {
    renderHabitA();
  });

  it("toggles a weekday bit off when its button is clicked", async () => {
    const habitA = plugin.settings.recurringTasks[0];
    await fakeSetting.weekdayCallbacks[0](); // Monday
    expect(habitA.weekdays & 1).toBe(0);
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it("toggles active off via the toggle control", async () => {
    const habitA = plugin.settings.recurringTasks[0];
    await fakeSetting.toggleCallbacks[0](false);
    expect(habitA.active).toBe(false);
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it("opens the RecurringTaskModal and applies its result when 'Edit' is clicked", async () => {
    const habitA = plugin.settings.recurringTasks[0];
    await fakeSetting.editCallback();
    expect(recurringModalInstances).toHaveLength(1);
    const modal = recurringModalInstances[0];
    expect(modal.def).toBe(habitA);
    expect(modal.open).toHaveBeenCalledOnce();

    await modal.onSubmit({ title: "New title", detail: "New detail" });
    expect(habitA.title).toBe("New title");
    expect(habitA.detail).toBe("New detail");
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  describe("inline title rename", () => {
    function startEdit(): HTMLInputElement {
      fakeSetting.nameEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return fakeSetting.nameEl.querySelector(".pm-recurring-task-title-input") as HTMLInputElement;
    }

    it("also opens edit mode on Enter/Space (keyboard accessibility), and ignores other keys", () => {
      fakeSetting.nameEl.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      expect(fakeSetting.nameEl.querySelector(".pm-recurring-task-title-input")).toBeNull();

      fakeSetting.nameEl.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      const input = fakeSetting.nameEl.querySelector(".pm-recurring-task-title-input") as HTMLInputElement;
      expect(input.value).toBe("Habit A");
    });

    it("swaps the row name for a pre-filled input on click", () => {
      const input = startEdit();
      expect(input.value).toBe("Habit A");
    });

    it("saves the trimmed title and re-renders on Enter", async () => {
      const input = startEdit();
      input.value = "  Renamed habit  ";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      await Promise.resolve();
      await Promise.resolve();
      expect(plugin.settings.recurringTasks[0].title).toBe("Renamed habit");
      expect(plugin.saveSettings).toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((tab as any).update).toHaveBeenCalled();
    });

    it("saves when blurred alone with a changed value (no explicit Enter)", async () => {
      const input = startEdit();
      input.value = "Blurred rename";
      input.dispatchEvent(new FocusEvent("blur"));
      await Promise.resolve();
      await Promise.resolve();
      expect(plugin.settings.recurringTasks[0].title).toBe("Blurred rename");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });

    it("does not save on Escape", () => {
      const input = startEdit();
      input.value = "Unsaved rename";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(plugin.settings.recurringTasks[0].title).toBe("Habit A");
      expect(plugin.saveSettings).not.toHaveBeenCalled();
    });

    it("does not save when Enter is pressed with an unchanged value", async () => {
      const input = startEdit();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      await Promise.resolve();
      expect(plugin.saveSettings).not.toHaveBeenCalled();
    });
  });
});
