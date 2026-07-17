// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Capture onChange callbacks installed by display() so tests can invoke them.
type ToggleCb = (value: boolean) => Promise<void>;
type TextCb = (value: string) => Promise<void>;
type ButtonCb = () => void | Promise<void>;
let toggleCallbacks: ToggleCb[] = [];
let textCallbacks: TextCb[] = [];
// Each row's buttons/extraButtons, in display order (one entry per Setting that has any).
let buttonCallbacks: ButtonCb[][] = [];
let extraButtonCallbacks: ButtonCb[][] = [];
// One real `nameEl` per `new Setting(...)` constructed during `display()`, in order — used
// to drive the inline title-rename input (click to open, dispatch events on the resulting
// `<input>`), which needs genuine DOM/focus/blur behavior rather than the plain-object stubs
// used for the rest of this file's Setting mock.
let nameEls: HTMLElement[] = [];

// Minimal Obsidian-style DOM helpers, same pattern as day-task-row.test.ts, needed for the
// real `nameEl` elements below (`createEl`/`addClass`/`empty`).
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
  // Obsidian exposes `createDiv` as a global (an unattached element when given no parent),
  // which the settings tab uses to group a habit row's controls.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).createDiv = function (opts?: { cls?: string }) {
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
    constructor(_app: unknown, _plugin: unknown) {}
  }

  class Setting {
    private rowButtons: ButtonCb[] = [];
    private rowExtraButtons: ButtonCb[] = [];
    settingEl = { addClass: () => {} };
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
    }
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
      // Real `buttonEl`, appended to `controlEl` as Obsidian does, so the tab can move the
      // weekday buttons into their own row.
      const buttonEl = document.createElement("button");
      this.controlEl.appendChild(buttonEl);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {
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
    onChange(fn: ToggleCb) { toggleCallbacks.push(fn); return this; }
  }

  return { PluginSettingTab, Setting, ToggleComponent, App: class {} };
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

describe("PMCompassSettingTab.display", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let plugin: any;
  let tab: PMCompassSettingTab;

  beforeEach(() => {
    document.body.innerHTML = "";
    toggleCallbacks = [];
    textCallbacks = [];
    buttonCallbacks = [];
    extraButtonCallbacks = [];
    nameEls = [];
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
    //                  textCallbacks[5]   = smallTaskMaxWeeksAhead
    //                  textCallbacks[6]   = dailyTasksHeading
    //                  textCallbacks[7]   = recurringTasksHeading
    //                  textCallbacks[8]   = dailyHabitsTag
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

  describe("smallTaskMaxWeeksAhead text", () => {
    it("sets smallTaskMaxWeeksAhead to the parsed integer", async () => {
      await textCallbacks[5]("2");
      expect(plugin.settings.smallTaskMaxWeeksAhead).toBe(2);
    });

    it("accepts 0 to disable", async () => {
      await textCallbacks[5]("0");
      expect(plugin.settings.smallTaskMaxWeeksAhead).toBe(0);
    });

    it("falls back to 1 when the value is not a valid number", async () => {
      await textCallbacks[5]("abc");
      expect(plugin.settings.smallTaskMaxWeeksAhead).toBe(1);
    });

    it("falls back to 1 when the value is negative", async () => {
      await textCallbacks[5]("-1");
      expect(plugin.settings.smallTaskMaxWeeksAhead).toBe(1);
    });

    it("calls saveSettings", async () => {
      await textCallbacks[5]("3");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe("dailyTasksHeading text", () => {
    it("sets dailyTasksHeading to the trimmed value", async () => {
      await textCallbacks[6]("  # To Do  ");
      expect(plugin.settings.dailyTasksHeading).toBe("# To Do");
    });

    it("falls back to '# Tasks' when the value is empty after trimming", async () => {
      await textCallbacks[6]("   ");
      expect(plugin.settings.dailyTasksHeading).toBe("# Tasks");
    });

    it("calls saveSettings", async () => {
      await textCallbacks[6]("# To Do");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe("recurringTasksHeading text", () => {
    it("sets recurringTasksHeading to the trimmed value", async () => {
      await textCallbacks[7]("  # Habits  ");
      expect(plugin.settings.recurringTasksHeading).toBe("# Habits");
    });

    it("falls back to '# Routine' when the value is empty after trimming", async () => {
      await textCallbacks[7]("   ");
      expect(plugin.settings.recurringTasksHeading).toBe("# Routine");
    });

    it("calls saveSettings", async () => {
      await textCallbacks[7]("# Habits");
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe("dailyHabitsTag text", () => {
    it("sets dailyHabitsTag to the trimmed value", async () => {
      await textCallbacks[8]("weekly");
      expect(plugin.settings.dailyHabitsTag).toBe("weekly");
    });

    it("strips a leading # from the tag value", async () => {
      await textCallbacks[8]("#habits");
      expect(plugin.settings.dailyHabitsTag).toBe("habits");
    });

    it("falls back to 'daily' when the value is empty after trimming", async () => {
      await textCallbacks[8]("  ");
      expect(plugin.settings.dailyHabitsTag).toBe("daily");
    });

    it("calls saveSettings", async () => {
      await textCallbacks[8]("custom");
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
    document.body.innerHTML = "";
    toggleCallbacks = [];
    textCallbacks = [];
    buttonCallbacks = [];
    extraButtonCallbacks = [];
    nameEls = [];
    recurringModalInstances.length = 0;
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

  it("does nothing when 'move up' is clicked on the first row (already disabled)", async () => {
    const [habitA, habitB] = plugin.settings.recurringTasks;
    const moveUpForA = extraButtonCallbacks[0][0];
    await moveUpForA();
    expect(habitA.order).toBe(0);
    expect(habitB.order).toBe(1);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("does nothing when 'move down' is clicked on the last row (already disabled)", async () => {
    const [habitA, habitB] = plugin.settings.recurringTasks;
    const moveDownForB = extraButtonCallbacks[1][1];
    await moveDownForB();
    expect(habitA.order).toBe(0);
    expect(habitB.order).toBe(1);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("swaps order with the next row when 'move down' is clicked on the first row", async () => {
    const [habitA, habitB] = plugin.settings.recurringTasks;
    const moveDownForA = extraButtonCallbacks[0][1];
    await moveDownForA();
    expect(habitA.order).toBe(1);
    expect(habitB.order).toBe(0);
  });

  it("opens the RecurringTaskModal and applies its result when 'Edit' is clicked", async () => {
    const habitA = plugin.settings.recurringTasks[0];
    const editForA = extraButtonCallbacks[0][2];
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

  it("removes the definition when delete is clicked", async () => {
    const deleteForA = extraButtonCallbacks[0][3];
    await deleteForA();
    expect(plugin.settings.recurringTasks.map((d: { id: string }) => d.id)).toEqual(["b"]);
  });

  // The "+ Add habit" row's Setting is constructed last, so the two habit rows'
  // nameEls are the two entries just before it.
  function habitANameEl() { return nameEls[nameEls.length - 3]; }

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
