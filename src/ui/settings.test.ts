// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

// Capture onChange callbacks installed by display() so tests can invoke them.
type ToggleCb = (value: boolean) => Promise<void>;
type TextCb = (value: string) => Promise<void>;
type ButtonCb = () => void | Promise<void>;
let toggleCallbacks: ToggleCb[] = [];
let textCallbacks: TextCb[] = [];
// Each text row's input element, in the same order — the number rows configure theirs.
let textInputEls: HTMLInputElement[] = [];
// Each row's buttons/extraButtons, in display order (one entry per Setting that has any).
let buttonCallbacks: ButtonCb[][] = [];
let extraButtonCallbacks: ButtonCb[][] = [];
// One real `nameEl` per `new Setting(...)` constructed during `display()`, in order — used
// to drive the inline title-rename input (click to open, dispatch events on the resulting
// `<input>`), which needs genuine DOM/focus/blur behavior rather than the plain-object stubs
// used for the rest of this file's Setting mock.
let nameEls: HTMLElement[] = [];
// Each row's name, description, classes and whether it is a heading, in display order —
// the block styling is driven off which rows carry `pm-setting-row`.
type SettingRow = { name?: string; desc?: string; classes: string[]; heading: boolean };
let rows: SettingRow[] = [];
// The row each `toggleCallbacks` entry was built on, so a test can name the toggle it wants
// instead of counting rows to it — a count a row added anywhere above would shift.
let toggleRows: SettingRow[] = [];

// Minimal Obsidian-style DOM helpers, same pattern as day-task-row.test.ts, needed for the
// real `nameEl` elements below (`createEl`/`addClass`/`empty`).
function installObsidianDOMPolyfills() {
  const htmlProto = bagOf(HTMLElement.prototype);
  type CreateElOpts = { cls?: string; text?: string; type?: string; attr?: Record<string, string> };
  htmlProto.createEl = function (this: HTMLElement, tag: string, opts?: CreateElOpts) {
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
  // Obsidian exposes `createDiv` as a global (an unattached element when given no parent),
  // which the settings tab uses to group a habit row's controls.
  bagOf(window).createDiv = function (opts?: { cls?: string }) {
    const el = document.createElement("div");
    if (opts?.cls) el.className = opts.cls;
    return el;
  };
}

beforeAll(() => {
  installObsidianDOMPolyfills();
});

vi.mock("obsidian", () => {
  class PluginSettingTab {
    containerEl!: HTMLElement;
    app: unknown;
    constructor(app: unknown, _plugin: unknown) {
      this.app = app;
    }
  }

  class Setting {
    private rowButtons: ButtonCb[] = [];
    private rowExtraButtons: ButtonCb[] = [];
    row = { name: undefined as string | undefined, desc: undefined as string | undefined,
      classes: [] as string[], heading: false };
    settingEl = { addClass: (cls: string) => { this.row.classes.push(cls); } };
    nameEl: HTMLElement;
    // Real element: the tab regroups the controls Obsidian appended here into a weekday
    // row and an action row, so the mock has to support actual DOM moves.
    controlEl: HTMLElement;

    constructor(_container: unknown) {
      this.nameEl = document.createElement("div");
      // Attached to the document so `.focus()`/`.blur()` on the inline-edit `<input>`
      // it later contains actually fire focus/blur events, matching real usage.
      document.body.appendChild(this.nameEl);
      nameEls.push(this.nameEl);
      this.controlEl = document.createElement("div");
      document.body.appendChild(this.controlEl);
      rows.push(this.row);
    }
    setName(name?: string) { this.row.name = name; return this; }
    setHeading() { this.row.heading = true; return this; }
    setDesc(desc?: string) { this.row.desc = desc; return this; }
    addToggle(build: (toggle: {
      setValue(v: boolean): typeof toggle;
      onChange(fn: ToggleCb): typeof toggle;
    }) => void) {
      let cb: ToggleCb | undefined;
      interface ToggleStub { setValue(v: boolean): ToggleStub; onChange(fn: ToggleCb): ToggleStub }
      const t: ToggleStub = { setValue: () => t, onChange: (fn: ToggleCb) => { cb = fn; return t; } };
      build(t);
      if (cb) {
        toggleCallbacks.push(cb);
        toggleRows.push(this.row);
      }
      return this;
    }
    addText(build: (text: {
      setPlaceholder(v: string): typeof text;
      setValue(v: string): typeof text;
      setDisabled(v: boolean): typeof text;
      onChange(fn: TextCb): typeof text;
    }) => void) {
      let cb: TextCb | undefined;
      interface TextStub {
        inputEl: HTMLInputElement;
        setPlaceholder(v: string): TextStub;
        setValue(v: string): TextStub;
        setDisabled(v: boolean): TextStub;
        onChange(fn: TextCb): TextStub;
      }
      const t: TextStub = {
        // A real element: the number entries set type/min/step on it.
        inputEl: document.createElement("input"),
        setPlaceholder: () => t,
        setValue: () => t,
        setDisabled: () => t,
        onChange: (fn: TextCb) => { cb = fn; return t; },
      };
      build(t);
      // Appended to `controlEl` as Obsidian does, so the tab can put a stepper before it.
      this.controlEl.appendChild(t.inputEl);
      textInputEls.push(t.inputEl);
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
      // Real `buttonEl`, appended to `controlEl` as Obsidian does, so the tab can move the
      // weekday buttons into their own row.
      const buttonEl = document.createElement("button");
      this.controlEl.appendChild(buttonEl);
      interface ButtonStub {
        buttonEl: HTMLButtonElement;
        setButtonText(v: string): ButtonStub;
        setCta(): ButtonStub;
        setDisabled(v: boolean): ButtonStub;
        onClick(fn: ButtonCb): ButtonStub;
      }
      const b: ButtonStub = {
        buttonEl,
        setButtonText: (v: string) => { buttonEl.textContent = v; return b; },
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
      // Obsidian renders an extra button as `div.clickable-icon`, not a `<button>` — a
      // distinction the weekday CSS relies on (`button:not(.clickable-icon)`), so the mock
      // has to reproduce it rather than emit a button here.
      const extraButtonEl = document.createElement("div");
      extraButtonEl.classList.add("clickable-icon");
      this.controlEl.appendChild(extraButtonEl);
      interface ExtraButtonStub {
        extraSettingsEl: HTMLElement;
        setIcon(v: string): ExtraButtonStub;
        setTooltip(v: string): ExtraButtonStub;
        setDisabled(v: boolean): ExtraButtonStub;
        onClick(fn: ButtonCb): ExtraButtonStub;
      }
      const b: ExtraButtonStub = {
        extraSettingsEl: extraButtonEl,
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

  // The recurring-task rows build their active toggle directly (so it can live on the
  // title line rather than in the control group). It records its callback in the same
  // `toggleCallbacks` list as `Setting.addToggle`, so tests drive both the same way.
  class ToggleComponent {
    toggleEl: HTMLElement;
    constructor(container: HTMLElement) {
      this.toggleEl = document.createElement("div");
      this.toggleEl.classList.add("checkbox-container");
      container.appendChild(this.toggleEl);
    }
    setValue() { return this; }
    onChange(fn: ToggleCb) {
      toggleCallbacks.push(fn);
      // Built while its own row is, so the row under construction is the last one made.
      toggleRows.push(rows[rows.length - 1]);
      return this;
    }
  }

  // Which Obsidian the tab thinks it is on. Below 1.13.0 by default, so the tests below
  // exercise the imperative display() render path (see PMCompassSettingTab.rerender);
  // `onApiVersion` flips it for the few that want the declarative one.
  const requireApiVersion = vi.fn(() => false);

  return {
    PluginSettingTab, Setting, ToggleComponent, App: class {}, requireApiVersion,
    normalizePath: (p: string) => p,
  };
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

// The tab only asks before deleting a habit; the recorder keeps that question out of the
// way, and a test runs the recorded action itself when it wants the delete to go through.
const { mockConfirmAction } = vi.hoisted(() => {
  const mockConfirmAction = Object.assign(
    (_app: unknown, required: boolean, message: string, onConfirm: () => void) => {
      mockConfirmAction.calls.push({ required, message, onConfirm });
    },
    { calls: [] as Array<{ required: boolean; message: string; onConfirm: () => void }> },
  );
  return { mockConfirmAction };
});

vi.mock("./task-creator", () => ({ confirmAction: mockConfirmAction }));

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

import { Setting, requireApiVersion } from "obsidian";
import type { SettingGroup } from "obsidian";
import { PMCompassSettingTab } from "./settings-tab";
import { DEFAULT_SETTINGS } from "../model/settings";
import type { PMCompassSettings } from "../model/settings";
import { ALL_WEEKDAYS } from "../model/daily/recurring-task";
import { day } from "../model/__testing__/dates";
import { asApp } from "../model/__testing__/as-app";
import { bagOf } from "./__testing__/dom-bag";
import type PMCompassPlugin from "../main";

/** The tab's own members, named rather than reached for through `any`: a container the
 *  tests stand in for, and the day-notes check they drive by hand. */
interface TabInternals {
  containerEl: { empty: () => void; scrollTop?: number };
  refreshDayNotesState(): Promise<void>;
  /** Obsidian 1.13.0+ redraws through this; below it, the tab calls display() instead. */
  update(): void;
}
const internals = (tab: PMCompassSettingTab) => tab as unknown as TabInternals;

/** The plugin the tab takes, which these stubs stand in for. */
const asPlugin = (plugin: ReturnType<typeof makePlugin>) => plugin as unknown as PMCompassPlugin;

/** The 1.12.x render path, reached through a cast so it isn't the deprecated symbol the
 *  obsidian types flag — the same shape the tab itself calls it through. */
const render = (tab: PMCompassSettingTab) => (tab as unknown as { display: () => void }).display();

/** The toggle of the row with this name. */
function toggleFor(name: string): ToggleCb {
  const index = toggleRows.findIndex((r) => r.name === name);
  if (index < 0) throw new Error(`No toggle on a row named "${name}"`);
  return toggleCallbacks[index];
}

/** The class the tab marks a habit row with, which is all a nameless row can be found by. */
const HABIT_ROW_CLASS = "pm-recurring-task-row";

/** Which of the rows drawn are habits, by index into `rows`/`nameEls`. */
const habitRowIndices = () =>
  rows.flatMap((r, i) => (r.classes.includes(HABIT_ROW_CLASS) ? [i] : []));

/** The active toggle of the habit at `index`. */
const habitToggle = (index: number): ToggleCb =>
  toggleCallbacks[
    toggleRows.flatMap((r, i) => (r.classes.includes(HABIT_ROW_CLASS) ? [i] : []))[index]
  ];

/** The vault's config folder, deliberately not the default `.obsidian`: the code under
 *  test has to read it off the vault rather than assume it. */
const CONFIG_DIR = ".vault-config";

/** An app stub for what the tab warns about: the Daily notes core plugin on or off, and
 *  whether it left a configuration behind. */
function appWithDailyNotes(enabled: boolean, hasConfig = false) {
  return asApp({
    internalPlugins: { getEnabledPluginById: () => (enabled ? {} : null) },
    vault: { configDir: CONFIG_DIR, adapter: { exists: async () => hasConfig } },
  });
}

function makePlugin(overrides: Partial<PMCompassSettings> = {}) {
  const settings: PMCompassSettings = { ...DEFAULT_SETTINGS, ...overrides };
  return {
    settings,
    manifest: { version: "1.0.0" },
    saveSettings: vi.fn().mockResolvedValue(undefined),
    refreshDashboard: vi.fn(),
  };
}

describe("PMCompassSettingTab.display", () => {
  let plugin: ReturnType<typeof makePlugin>;
  let tab: PMCompassSettingTab;

  beforeEach(() => {
    document.body.innerHTML = "";
    toggleCallbacks = [];
    toggleRows = [];
    textCallbacks = [];
    textInputEls = [];
    buttonCallbacks = [];
    extraButtonCallbacks = [];
    nameEls = [];
    rows = [];
    plugin = makePlugin();
    tab = new PMCompassSettingTab(appWithDailyNotes(true), asPlugin(plugin));
    internals(tab).containerEl = { empty: vi.fn() };
    render(tab);
    // After display(): toggleCallbacks[0] = split the task lists
    //                  toggleCallbacks[1] = merge daily and project tasks
    //                  toggleCallbacks[2] = sync toggle
    //                  toggleCallbacks[3] = verify listings
    //                  textCallbacks[0]   = projectsFolder
    //                  textCallbacks[1]   = inboxFilePath
    //                  textCallbacks[2]   = inboxStaleAfterDays
    //                  textCallbacks[3]   = unclosedDaysBefore
    //                  textCallbacks[4]   = unclosedDaysAfter
    //                  textCallbacks[5]   = dailyTasksHeading
    //                  textCallbacks[6]   = recurringTasksHeading
    //                  textCallbacks[7]   = dailyHabitsTag
    //                  buttonCallbacks[last] = "+ Add a habit" (no rows since recurringTasks is empty)
  });

  describe("sync-obsidian-pm toggle", () => {
    const syncToggle = () => toggleCallbacks[2];

    it("updates syncObsidianPmSettings to the new value", async () => {
      await syncToggle()(false);
      expect(plugin.settings.syncObsidianPmSettings).toBe(false);
    });

    it("calls saveSettings", async () => {
      await syncToggle()(true);
      expect(plugin.saveSettings).toHaveBeenCalledOnce();
    });

    it("re-renders by calling display again after saving", async () => {
      const spy = vi.spyOn(tab, "display");
      await syncToggle()(false);
      expect(spy).toHaveBeenCalled();
    });
  });

  describe("verify-listings toggle", () => {
    const verifyToggle = () => toggleCallbacks[3];

    it("updates verifyListingsOnLoad to the new value", async () => {
      await verifyToggle()(false);
      expect(plugin.settings.verifyListingsOnLoad).toBe(false);
    });

    it("calls saveSettings", async () => {
      await verifyToggle()(false);
      expect(plugin.saveSettings).toHaveBeenCalledOnce();
    });
  });

  describe("confirmation toggles", () => {
    const toggles = [
      ["Ask before deleting a task or item", "confirmDeletes"],
      ["Ask before removing a note", "confirmNoteRemoval"],
      ["Ask before moving a task by drag and drop", "confirmTaskMoves"],
      ["Ask before removing a dependency", "confirmDependencyRemoval"],
    ] as const;

    it("names one row per confirmation, at the bottom of the page", () => {
      expect(rows.slice(-5).map((r) => r.name)).toEqual([
        "Confirmations", ...toggles.map(([name]) => name),
      ]);
    });

    it.each(toggles)("writes the setting behind %s and saves", async (name, key) => {
      await toggleFor(name)(false);
      expect(plugin.settings[key]).toBe(false);
      expect(plugin.saveSettings).toHaveBeenCalledOnce();
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

  describe("number fields", () => {
    // Same indices as textCallbacks: [2] stale threshold, [3] days before, [4] days after.
    it("are pickers, not free text: digits only, no negatives", () => {
      for (const idx of [2, 3, 4]) {
        expect(textInputEls[idx].type).toBe("number");
        expect(textInputEls[idx].min).toBe("0");
        expect(textInputEls[idx].step).toBe("1");
      }
    });

    // One [less, more] pair per number row, in build order, ahead of the habit rows'.
    const steppersFor = (row: number) => extraButtonCallbacks[row];

    it("steps the value up, saving and showing the new one", async () => {
      await steppersFor(1)[1]();
      expect(plugin.settings.unclosedDaysBefore).toBe(31);
      expect(textInputEls[3].value).toBe("31");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });

    it("steps the value down", async () => {
      await steppersFor(2)[0]();
      expect(plugin.settings.unclosedDaysAfter).toBe(14);
      expect(textInputEls[4].value).toBe("14");
    });

    it("puts 'less' left of the value and 'more' right of it", () => {
      // The number rows come first, so their controls are the first three built.
      const control = textInputEls[3].parentElement!;
      expect([...control.children].indexOf(textInputEls[3])).toBe(1);
      expect(control.children).toHaveLength(3);
    });

    it("stops at zero rather than going negative", async () => {
      plugin.settings.inboxStaleAfterDays = 0;
      await steppersFor(0)[0]();
      expect(plugin.settings.inboxStaleAfterDays).toBe(0);
    });

    // `type="number"` blocks letters but not a leading "-", and an empty field is left
    // alone mid-edit — either would otherwise sit there looking saved.
    it("shows what was stored again once the edit is over", async () => {
      const input = textInputEls[3];
      await textCallbacks[3]("-1");
      input.value = "-1";
      input.dispatchEvent(new Event("blur"));
      expect(input.value).toBe("30");

      await textCallbacks[3]("");
      input.value = "";
      input.dispatchEvent(new Event("blur"));
      expect(input.value).toBe("30");
    });

    it("leaves an accepted value in place", async () => {
      const input = textInputEls[3];
      await textCallbacks[3]("12");
      input.value = "12";
      input.dispatchEvent(new Event("blur"));
      expect(input.value).toBe("12");
    });
  });

  describe("inboxStaleAfterDays number", () => {
    it("sets inboxStaleAfterDays to the parsed integer", async () => {
      await textCallbacks[2]("14");
      expect(plugin.settings.inboxStaleAfterDays).toBe(14);
    });

    it("accepts 0 to disable", async () => {
      await textCallbacks[2]("0");
      expect(plugin.settings.inboxStaleAfterDays).toBe(0);
    });

    it("keeps the stored value when the field is emptied mid-edit", async () => {
      await textCallbacks[2]("");
      expect(plugin.settings.inboxStaleAfterDays).toBe(7);
      expect(plugin.saveSettings).not.toHaveBeenCalled();
    });

    it("ignores a negative value", async () => {
      await textCallbacks[2]("-1");
      expect(plugin.settings.inboxStaleAfterDays).toBe(7);
    });

    it("calls saveSettings", async () => {
      await textCallbacks[2]("10");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe("unclosedDaysBefore number", () => {
    it("sets unclosedDaysBefore to the parsed integer", async () => {
      await textCallbacks[3]("3");
      expect(plugin.settings.unclosedDaysBefore).toBe(3);
    });

    it("accepts 0 to disable", async () => {
      await textCallbacks[3]("0");
      expect(plugin.settings.unclosedDaysBefore).toBe(0);
    });

    it("keeps the stored value when the field is emptied mid-edit", async () => {
      await textCallbacks[3]("");
      expect(plugin.settings.unclosedDaysBefore).toBe(30);
      expect(plugin.saveSettings).not.toHaveBeenCalled();
    });

    it("ignores a negative value", async () => {
      await textCallbacks[3]("-1");
      expect(plugin.settings.unclosedDaysBefore).toBe(30);
    });

    it("calls saveSettings", async () => {
      await textCallbacks[3]("5");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe("unclosedDaysAfter number", () => {
    it("sets unclosedDaysAfter to the parsed integer", async () => {
      await textCallbacks[4]("14");
      expect(plugin.settings.unclosedDaysAfter).toBe(14);
    });

    it("accepts 0 to disable", async () => {
      await textCallbacks[4]("0");
      expect(plugin.settings.unclosedDaysAfter).toBe(0);
    });

    it("keeps the stored value when the field is emptied mid-edit", async () => {
      await textCallbacks[4]("");
      expect(plugin.settings.unclosedDaysAfter).toBe(15);
      expect(plugin.saveSettings).not.toHaveBeenCalled();
    });

    it("ignores a negative value", async () => {
      await textCallbacks[4]("-1");
      expect(plugin.settings.unclosedDaysAfter).toBe(15);
    });

    it("calls saveSettings", async () => {
      await textCallbacks[4]("3");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe("dailyTasksHeading text", () => {
    it("sets dailyTasksHeading to the trimmed value", async () => {
      await textCallbacks[5]("  # To Do  ");
      expect(plugin.settings.dailyTasksHeading).toBe("# To Do");
    });

    it("falls back to '# Tasks' when the value is empty after trimming", async () => {
      await textCallbacks[5]("   ");
      expect(plugin.settings.dailyTasksHeading).toBe("# Tasks");
    });

    it("calls saveSettings", async () => {
      await textCallbacks[5]("# To Do");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe("recurringTasksHeading text", () => {
    it("sets recurringTasksHeading to the trimmed value", async () => {
      await textCallbacks[6]("  # Habits  ");
      expect(plugin.settings.recurringTasksHeading).toBe("# Habits");
    });

    it("falls back to '# Routine' when the value is empty after trimming", async () => {
      await textCallbacks[6]("   ");
      expect(plugin.settings.recurringTasksHeading).toBe("# Routine");
    });

    it("calls saveSettings", async () => {
      await textCallbacks[6]("# Habits");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe("dailyHabitsTag text", () => {
    it("sets dailyHabitsTag to the trimmed value", async () => {
      await textCallbacks[7]("weekly");
      expect(plugin.settings.dailyHabitsTag).toBe("weekly");
    });

    it("strips a leading # from the tag value", async () => {
      await textCallbacks[7]("#habits");
      expect(plugin.settings.dailyHabitsTag).toBe("habits");
    });

    it("falls back to 'daily' when the value is empty after trimming", async () => {
      await textCallbacks[7]("  ");
      expect(plugin.settings.dailyHabitsTag).toBe("daily");
    });

    it("calls saveSettings", async () => {
      await textCallbacks[7]("custom");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe("section grouping", () => {
    // Where a block opens is left to the CSS, which can see the row before.
    it("marks every row but the headings, so the CSS can join them into blocks", () => {
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.classes.includes("pm-setting-row")).toBe(!row.heading);
      }
    });

    // Where it closes it can't: the next heading is ahead of the row, so the tab says it.
    it("marks the last row of each section as the end of its block", () => {
      const runEnds = rows.map((row) => row.classes.includes("pm-setting-row--run-end"));
      const expected = rows.map((_, i) => i === rows.length - 1 || rows[i + 1].heading);
      expect(runEnds).toEqual(expected);
    });

    // On 1.13.0+ a section is a setting group of its own, which is what gives it a card
    // and a gap of its own; a flat list with heading rows renders as one undivided card.
    it("hands 1.13 one group per section, each with its heading and its own rows", () => {
      const defs = tab.getSettingDefinitions();
      const groups = defs.filter((d) => "type" in d && d.type === "group");
      expect(groups.map((g) => ("heading" in g ? g.heading : undefined))).toEqual([
        "General",
        "Project manager integration",
        "Daily notes integration",
        "Recurring daily habits",
        "Confirmations",
      ]);
      for (const group of groups) {
        expect("items" in group && group.items?.length).toBeTruthy();
      }
    });

    it("draws nothing for the nameless description row, which is all it is there for", () => {
      const habits = tab.getSettingDefinitions()
        .find((d) => "type" in d && d.type === "group" && d.heading === "Recurring daily habits");
      const first = habits && "items" in habits ? habits.items?.[0] : undefined;
      const descRow = first && "searchable" in first ? first : undefined;
      const setting = new Setting(document.body);
      const drawn = () => (setting as unknown as { row: { name?: string; desc?: string } }).row;

      // It exists only so a definition with no `render` isn't dropped; calling it must
      // leave the row Obsidian made for it untouched.
      descRow?.render?.(setting, {} as unknown as SettingGroup);

      expect(drawn().name).toBeUndefined();
      expect(drawn().desc).toBeUndefined();
    });

    it("carries a section's own description into its first row, which a group heading can't hold", () => {
      const habits = tab.getSettingDefinitions()
        .find((d) => "type" in d && d.type === "group" && d.heading === "Recurring daily habits");
      const first = habits && "items" in habits ? habits.items?.[0] : undefined;
      // A nested page carries no `searchable`, so this narrows the row to a plain one.
      const descRow = first && "searchable" in first ? first : undefined;
      expect(descRow?.name).toBe("");
      expect(descRow?.desc).toContain("Habits inserted automatically");
      // A nameless row is nothing to find, and searching it would only turn up its section.
      expect(descRow?.searchable).toBe(false);
      // A definition with no `render` is dropped, description or not — hence the empty one.
      expect(typeof descRow?.render).toBe("function");
    });

    // The habits are data the user adds, reorders and removes, which is what 1.13's list
    // type is for: it draws the drag handles, the delete buttons and the add control, so
    // the rows below carry none of their own.
    it("hands 1.13 the habits as a list, with the affordances left to Obsidian", () => {
      const list = tab.getSettingDefinitions().find((d) => "type" in d && d.type === "list");
      expect(list).toBeDefined();
      const asList = list && "onReorder" in list ? list : undefined;
      expect(typeof asList?.onReorder).toBe("function");
      expect(typeof asList?.onDelete).toBe("function");
      expect(asList?.addItem?.name).toBe("Add a habit");
      expect(asList?.items?.length).toBe(plugin.settings.recurringTasks.length);
    });

    it("puts a section's own description on its heading row on the display path", () => {
      const heading = rows.find((row) => row.heading && row.name === "Recurring daily habits");
      expect(heading?.desc).toContain("Habits inserted automatically");
    });
  });

  describe("daily notes core plugin warning", () => {
    const WARNING = "No day note can be created";

    /** The tab's row names once its day-notes check has answered, which reads the vault.
     *  Read across the sections, which is how the 1.13 path hands its rows over. */
    const namesAfterCheck = async (app: unknown) => {
      const built = new PMCompassSettingTab(asApp(app), asPlugin(plugin));
      internals(built).containerEl = { empty: vi.fn() };
      render(built);
      await internals(built).refreshDayNotesState();
      return built.getSettingDefinitions().flatMap((group) =>
        ("items" in group ? group.items ?? [] : []).map((d) => ("name" in d ? d.name : "")),
      );
    };

    it("warns when the core plugin is off and left no configuration", async () => {
      expect(await namesAfterCheck(appWithDailyNotes(false))).toContain(WARNING);
    });

    it("says nothing when the core plugin is on", async () => {
      expect(await namesAfterCheck(appWithDailyNotes(true))).not.toContain(WARNING);
    });

    it("says nothing when the plugin is off but its configuration remains", async () => {
      expect(await namesAfterCheck(appWithDailyNotes(false, true))).not.toContain(WARNING);
    });

    it("settles after one re-render rather than rebuilding forever", async () => {
      const built = new PMCompassSettingTab(appWithDailyNotes(false), asPlugin(plugin));
      internals(built).containerEl = { empty: vi.fn() };
      const rendered = vi.spyOn(built, "display");
      await internals(built).refreshDayNotesState();
      await internals(built).refreshDayNotesState();
      expect(rendered).toHaveBeenCalledTimes(1);
    });
  });

  describe("scroll position", () => {
    it("restores containerEl.scrollTop after a re-render triggered by a settings change", async () => {
      internals(tab).containerEl.scrollTop = 250;
      await toggleCallbacks[2](false); // triggers this.display() internally
      expect(internals(tab).containerEl.scrollTop).toBe(250);
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

describe("PMCompassSettingTab — redrawing after a change", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    toggleCallbacks = [];
    toggleRows = [];
    vi.mocked(requireApiVersion).mockReturnValue(false);
  });

  // The version is read from a module-level mock the rest of the file shares, and the
  // tests below leave it on 1.13: put it back rather than rely on this block's order.
  afterEach(() => { vi.mocked(requireApiVersion).mockReturnValue(false); });

  /** A tab whose two redraw paths are both watchable. */
  function makeTab() {
    const plugin = makePlugin();
    const tab = new PMCompassSettingTab(appWithDailyNotes(true), asPlugin(plugin));
    internals(tab).containerEl = { empty: vi.fn() };
    const update = vi.fn();
    internals(tab).update = update;
    render(tab);
    const display = vi.spyOn(tab as unknown as { display: () => void }, "display");
    return { tab, plugin, display, update };
  }

  it("redraws through update() on 1.13.0 and later", async () => {
    vi.mocked(requireApiVersion).mockReturnValue(true);
    const { plugin, display, update } = makeTab();

    // The sync toggle disables the projects-folder row below it, so the tab is rebuilt.
    await toggleCallbacks[2](true);

    expect(update).toHaveBeenCalled();
    expect(display).not.toHaveBeenCalled();
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it("redraws through display() below 1.13.0, where there is no declarative pipeline", async () => {
    const { display, update } = makeTab();

    await toggleCallbacks[2](true);

    expect(display).toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("PMCompassSettingTab — recurring habit rows", () => {
  let plugin: ReturnType<typeof makePlugin>;
  let tab: PMCompassSettingTab;

  function renderWithHabits() {
    document.body.innerHTML = "";
    toggleCallbacks = [];
    toggleRows = [];
    textCallbacks = [];
    textInputEls = [];
    buttonCallbacks = [];
    extraButtonCallbacks = [];
    nameEls = [];
    rows = [];
    recurringModalInstances.length = 0;
    plugin = makePlugin({
      recurringTasks: [
        {
          id: "a", title: "Habit A", weekdays: 0b0011111,
          order: 0, active: true, createdAt: day("2026-01-01"), detail: "",
        },
        {
          id: "b", title: "Habit B", weekdays: ALL_WEEKDAYS,
          order: 1, active: false, createdAt: day("2026-01-01"), detail: "",
        },
      ],
    });
    tab = new PMCompassSettingTab(appWithDailyNotes(true), asPlugin(plugin));
    internals(tab).containerEl = { empty: vi.fn() };
    render(tab);
  }

  beforeEach(() => {
    renderWithHabits();
    // habitToggle(0) = active toggle for Habit A
    // habitToggle(1) = active toggle for Habit B
    // Row buttons: buttonCallbacks[0] = 7 weekday toggles for Habit A
    //              buttonCallbacks[1] = 7 weekday toggles for Habit B
    //              buttonCallbacks[2] = "+ Add a habit"
    // Row extra buttons, addressed from the end so the number rows' steppers above them
    // don't shift the indices:
    //   extraButtonCallbacks.at(-2) = [up, down, edit, delete] for Habit A
    //   extraButtonCallbacks.at(-1) = [up, down, edit, delete] for Habit B
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
    await habitToggle(0)(false);
    expect(habitA.active).toBe(false);
  });

  it("swaps order with the previous row when 'move up' is clicked on the second row", async () => {
    const [habitA, habitB] = plugin.settings.recurringTasks;
    const moveUpForB = extraButtonCallbacks.at(-1)![0];
    await moveUpForB();
    expect(habitA.order).toBe(1);
    expect(habitB.order).toBe(0);
  });

  it("does nothing when 'move up' is clicked on the first row (already disabled)", async () => {
    const [habitA, habitB] = plugin.settings.recurringTasks;
    const moveUpForA = extraButtonCallbacks.at(-2)![0];
    await moveUpForA();
    expect(habitA.order).toBe(0);
    expect(habitB.order).toBe(1);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("does nothing when 'move down' is clicked on the last row (already disabled)", async () => {
    const [habitA, habitB] = plugin.settings.recurringTasks;
    const moveDownForB = extraButtonCallbacks.at(-1)![1];
    await moveDownForB();
    expect(habitA.order).toBe(0);
    expect(habitB.order).toBe(1);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("swaps order with the next row when 'move down' is clicked on the first row", async () => {
    const [habitA, habitB] = plugin.settings.recurringTasks;
    const moveDownForA = extraButtonCallbacks.at(-2)![1];
    await moveDownForA();
    expect(habitA.order).toBe(1);
    expect(habitB.order).toBe(0);
  });

  it("opens the RecurringTaskModal and applies its result when 'Edit' is clicked", async () => {
    const habitA = plugin.settings.recurringTasks[0];
    const editForA = extraButtonCallbacks.at(-2)![2];
    await editForA();
    expect(recurringModalInstances).toHaveLength(1);
    const modal = recurringModalInstances[0];
    expect(modal.def).toBe(habitA);
    expect(modal.open).toHaveBeenCalledOnce();

    await modal.onSubmit({ title: "New title", detail: "New detail" });
    expect(habitA.title).toBe("New title");
    expect(habitA.detail).toBe("New detail");
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it("removes the definition when delete is clicked and the question is answered", async () => {
    const deleteForA = extraButtonCallbacks.at(-2)![3];
    await deleteForA();
    expect(mockConfirmAction.calls.at(-1)!.message).toBe('Delete "Habit A"?');
    mockConfirmAction.calls.at(-1)!.onConfirm();
    expect(plugin.settings.recurringTasks.map((d: { id: string }) => d.id)).toEqual(["b"]);
  });

  it("keeps the definition while the question goes unanswered", async () => {
    const deleteForA = extraButtonCallbacks.at(-2)![3];
    await deleteForA();
    expect(plugin.settings.recurringTasks.map((d: { id: string }) => d.id)).toEqual(["a", "b"]);
  });

  it("deletes without asking when the confirmation is turned off", async () => {
    plugin.settings.confirmDeletes = false;
    await extraButtonCallbacks.at(-2)![3]();
    expect(mockConfirmAction.calls.at(-1)!.required).toBe(false);
  });

  // On 1.13.0+ these two arrive from Obsidian's own list affordances — a drag handle and a
  // delete button it draws itself — rather than from buttons in the row.
  describe("the affordances 1.13 drives from the list", () => {
    /** The habits list definition, with a third habit so a drag can cross a row. */
    const listDef = () => {
      plugin.settings.recurringTasks.push({
        id: "c", title: "Habit C", weekdays: ALL_WEEKDAYS,
        order: 2, active: true, createdAt: day("2026-01-01"), detail: "",
      });
      const def = tab.getSettingDefinitions().find((d) => "type" in d && d.type === "list");
      return def && "onReorder" in def ? def : undefined;
    };
    /** The habit ids in the order the tab would draw them. */
    const drawnOrder = () => [...plugin.settings.recurringTasks]
      .sort((x: { order: number }, y: { order: number }) => x.order - y.order)
      .map((d: { id: string }) => d.id);

    it("renumbers the whole run when a habit is dragged past its neighbours", () => {
      listDef()?.onReorder?.(0, 2);
      expect(drawnOrder()).toEqual(["b", "c", "a"]);
    });

    it("renumbers when a habit is dragged back up the list", () => {
      listDef()?.onReorder?.(2, 0);
      expect(drawnOrder()).toEqual(["c", "a", "b"]);
    });

    it("removes the habit the list reports by index", () => {
      listDef()?.onDelete?.(1);
      mockConfirmAction.calls.at(-1)!.onConfirm();
      expect(drawnOrder()).toEqual(["a", "c"]);
    });

    it("removes nothing for an index the list no longer has", () => {
      listDef()?.onDelete?.(99);
      expect(drawnOrder()).toEqual(["a", "b", "c"]);
    });

    it("adds a habit from the list's own add control", async () => {
      // A blank habit, for the user to name from the row it adds. Obsidian hands the
      // action the element that was clicked; the tab's own action ignores it.
      listDef()?.addItem?.action(document.createElement("button"));

      await vi.waitFor(() =>
        expect(plugin.settings.recurringTasks.map((d) => d.title)).toContain("New habit"));
      expect(plugin.saveSettings).toHaveBeenCalled();
    });

    /** Draws the list's first habit row the way Obsidian does, into a Setting of its own,
     *  or into the one given — which is how a re-render reaches an existing row. */
    const renderFirstRow = (into?: Setting) => {
      const item = listDef()?.items?.[0];
      const setting = into ?? new Setting(document.body);
      extraButtonCallbacks = [];
      recurringModalInstances.length = 0;
      // Obsidian hands `render` the group the row belongs to as well; the tab's rows never
      // read it, so a stand-in is enough to call one here.
      const group = {} as unknown as SettingGroup;
      if (item && "render" in item) item.render?.(setting, group);
      return setting;
    };
    const flushObservers = () => new Promise((resolve) => window.setTimeout(resolve, 0));

    it("leaves the row itself only its edit button, the other two being Obsidian's", async () => {
      renderFirstRow();
      expect(extraButtonCallbacks).toHaveLength(1);
      const rowButtons = extraButtonCallbacks[0];
      expect(rowButtons).toHaveLength(1);
      await rowButtons[0]();
      expect(recurringModalInstances).toHaveLength(1);
    });

    it("takes into the action row what the list appends once the row is drawn", async () => {
      const setting = renderFirstRow();
      // Obsidian adds its drag handle and delete button to `controlEl` after `render` runs,
      // which would otherwise leave them outside the row's own action group.
      const handle = document.createElement("div");
      const del = document.createElement("div");
      setting.controlEl.append(handle, del);
      await flushObservers();

      const actions = setting.controlEl.querySelector(".pm-recurring-task-actions");
      expect([...(actions?.children ?? [])].slice(-2)).toEqual([handle, del]);
      expect([...setting.controlEl.children].map((c) => c.className)).toEqual([
        "pm-recurring-task-days",
        "pm-recurring-task-actions",
      ]);
    });

    // `update()` empties a row's control and draws it again into the same element, so the
    // render before it must not go on claiming what lands there for its own stale groups.
    it("leaves the groups alone when the row is drawn again into the same control", async () => {
      const setting = renderFirstRow();
      const stale = setting.controlEl.querySelector(".pm-recurring-task-actions");
      setting.controlEl.empty();
      renderFirstRow(setting);
      const handle = document.createElement("div");
      setting.controlEl.appendChild(handle);
      await flushObservers();

      expect([...setting.controlEl.children].map((c) => c.className)).toEqual([
        "pm-recurring-task-days",
        "pm-recurring-task-actions",
      ]);
      // The stale group keeps its own edit button and takes nothing more.
      expect(stale?.contains(handle)).toBe(false);
      expect(handle.parentElement?.className).toBe("pm-recurring-task-actions");
    });
  });

  function habitANameEl() {
    return nameEls[habitRowIndices()[0]];
  }

  // Obsidian would otherwise stack each of these controls as its own full-width row on a
  // phone; the grouping is what lets the CSS lay a definition out as title / Mo–Su / actions.
  describe("row grouping", () => {
    it("puts the seven weekday buttons in their own row, and the rest in an action row", () => {
      const dayRows = document.querySelectorAll(".pm-recurring-task-days");
      expect(dayRows).toHaveLength(2);
      expect([...dayRows[0].querySelectorAll("button")].map((b) => b.textContent)).toEqual([
        "Mo", "Tu", "We", "Th", "Fr", "Sa", "Su",
      ]);
      // Move up/down, edit and delete move out of the weekday row and into the action row.
      const actionRow = document.querySelectorAll(".pm-recurring-task-actions")[0];
      expect(actionRow.querySelectorAll(".clickable-icon")).toHaveLength(4);
      // Nothing is left behind: `controlEl` holds exactly the two groups.
      const control = actionRow.parentElement!;
      expect([...control.children].map((c) => c.className)).toEqual([
        "pm-recurring-task-days",
        "pm-recurring-task-actions",
      ]);
    });

    it("greys the weekday row only while the definition is inactive", () => {
      const dayRows = document.querySelectorAll(".pm-recurring-task-days");
      // Habit A is active, Habit B is not.
      expect(dayRows[0].classList.contains("pm-recurring-task-days--inactive")).toBe(false);
      expect(dayRows[1].classList.contains("pm-recurring-task-days--inactive")).toBe(true);
    });

    it("puts the active toggle on the title line", () => {
      expect(habitANameEl().querySelector(".checkbox-container")).not.toBeNull();
    });
  });

  describe("inline title rename", () => {
    // Focuses the input, matching real usage (the user must click/tab into the always-
    // rendered field to type into it) — without a real focus, jsdom's `el.blur()` inside
    // wireCommitOnKey's Enter handling is a no-op, so the commit's "blur" listener never fires.
    function titleInput(): HTMLInputElement {
      const input = habitANameEl().querySelector(".pm-recurring-task-title-input") as HTMLInputElement;
      input.focus();
      return input;
    }

    it("renders the title as a pre-filled, always-editable input (not a click-to-edit label)", () => {
      const input = titleInput();
      expect(input).not.toBeNull();
      expect(input.value).toBe("Habit A");
    });

    it("typing any character (including Enter/Space) does not discard or reset the input", () => {
      const input = titleInput();
      for (const key of ["a", " ", "Enter", "z"]) {
        input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      }
      // Enter above already committed once (see below); confirm the element itself was
      // never torn down/recreated mid-edit.
      expect(habitANameEl().querySelector(".pm-recurring-task-title-input")).toBe(input);
    });

    it("saves the trimmed title and re-renders on Enter", async () => {
      const input = titleInput();
      const displaySpy = vi.spyOn(tab, "display");
      input.value = "  Renamed habit  ";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      await Promise.resolve();
      await Promise.resolve();
      expect(plugin.settings.recurringTasks[0].title).toBe("Renamed habit");
      expect(plugin.saveSettings).toHaveBeenCalled();
      expect(displaySpy).toHaveBeenCalled();
    });

    it("saves when blurred alone with a changed value (no explicit Enter)", async () => {
      const input = titleInput();
      input.value = "Blurred rename";
      input.dispatchEvent(new FocusEvent("blur"));
      await Promise.resolve();
      await Promise.resolve();
      expect(plugin.settings.recurringTasks[0].title).toBe("Blurred rename");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });

    it("reverts the input's text without saving on Escape", () => {
      const input = titleInput();
      input.value = "Unsaved rename";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(input.value).toBe("Habit A");
      expect(plugin.settings.recurringTasks[0].title).toBe("Habit A");
      expect(plugin.saveSettings).not.toHaveBeenCalled();
    });

    it("does not save when Enter is pressed with an unchanged value", async () => {
      const input = titleInput();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      await Promise.resolve();
      expect(plugin.saveSettings).not.toHaveBeenCalled();
    });
  });
});
