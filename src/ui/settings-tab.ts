import { App, PluginSettingTab, Setting, ToggleComponent, requireApiVersion } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import { Icon } from "./icons";
import type PMCompassPlugin from "../main";
import type { PMCompassSettings } from "../model/settings";
import { startOfDay } from "../model/dates";
import { ALL_WEEKDAYS, type RecurringTaskDefinition } from "../model/daily/recurring-task";
import { RecurringTaskModal } from "./recurring-task-modal";
import { confirmAction } from "./task-creator";
import { wireCommitOnKey } from "./inline-edit";

const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

// One unit of the settings tab: its searchable name and description, plus a builder that
// populates the row. The same entries drive both render paths (see buildSections).
interface SettingEntry {
  name: string;
  desc?: string;
  aliases?: string[];
  build: (setting: Setting) => unknown;
}

// A run of related rows under one heading. On 1.13.0+ each section is a setting group of
// its own, which is what puts a card and a gap around it; on 1.12.x the heading is a row.
interface SettingSection {
  heading: string;
  desc?: string;
  entries: SettingEntry[];
  list?: SettingList;
}

// The rows of a section that stand for items the user adds, reorders and removes. On 1.13.0+
// Obsidian draws those affordances itself from the callbacks below — a drag handle and a
// delete button per row, and an add control in the list header. On 1.12.x there is no such
// list, so the rows carry the affordances themselves and `add` follows as a row of its own.
interface SettingList {
  /** Names the list on 1.13.0+, where it is a card of its own under the section. The 1.12.x
   *  rows follow the section's own heading, so they need no second one. */
  heading: string;
  /** The item rows. `ownAffordances` asks each to draw its own move and delete buttons,
   *  which is what the 1.12.x path needs and the 1.13.0+ list supplies for itself. */
  entries: (ownAffordances: boolean) => SettingEntry[];
  /** Names the add control: 1.13.0+ draws it in the list header, and 1.12.x gets a row of
   *  its own carrying the same words. Neither is searchable — the 1.13.0+ header control
   *  isn't indexed, and 1.12.x has no search to be found by. */
  addName: string;
  add: () => void;
  onReorder: (from: number, to: number) => void;
  onDelete: (index: number) => void;
  emptyState: string;
}

/** The row 1.12.x adds an item through, where the list draws no control of its own. The
 *  button says what the row is for, so a name of its own would only repeat it. */
function addRow(list: SettingList): SettingEntry {
  return {
    name: "",
    build: (setting) =>
      setting.addButton((btn) => btn.setButtonText(`+ ${list.addName}`).onClick(list.add)),
  };
}

/** Fills a row and marks it for the CSS that joins a run of rows into one block on 1.12.x.
 *  On 1.13.0+ the card comes from the group instead and the class is inert. Both render
 *  paths go through here, so a row is built the same way whichever one asked for it. */
function renderRow(entry: SettingEntry, setting: Setting): void {
  setting.settingEl.addClass("pm-setting-row");
  entry.build(setting);
}

/** The settings fields holding one primitive type, so an entry can name the field it
 *  edits instead of spelling out a getter and a setter for it. Assignable both ways, or
 *  `T` of `string` would take in a field narrowed to an enum the entry can't honour. */
type SettingKeyOf<T> = {
  [K in keyof PMCompassSettings]:
    PMCompassSettings[K] extends T ? (T extends PMCompassSettings[K] ? K : never) : never;
}[keyof PMCompassSettings];

export class PMCompassSettingTab extends PluginSettingTab {
  plugin: PMCompassPlugin;
  /** Whether no day note can be created — the state the daily notes section warns about.
   *  Answering it reads the vault, so a tab opened on such a vault warns on the re-render
   *  `refreshDayNotesState` asks for, a moment after it is drawn. */
  private dayNotesBlocked = false;

  constructor(app: App, plugin: PMCompassPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** Rebuilds the tab if what it says about day notes has gone stale — the core plugin
   *  can have been turned on or off since it was last drawn. Checked on each build, so a
   *  toggle shows on the next one. Settles after one re-render. */
  private async refreshDayNotesState(): Promise<void> {
    const blocked = !await this.plugin.vault.dayNotes.canCreate();
    if (blocked === this.dayNotesBlocked) return;
    this.dayNotesBlocked = blocked;
    this.rerender();
  }

  // Obsidian 1.13.0+ renders the tab from these and indexes them for the settings
  // search. Each entry builds its own widget in a `render` callback.
  getSettingDefinitions(): SettingDefinitionItem[] {
    const toDefinition = (entry: SettingEntry) => ({
      name: entry.name,
      desc: entry.desc,
      aliases: entry.aliases,
      render: (setting: Setting) => renderRow(entry, setting),
    });

    return this.buildSections().flatMap((section): SettingDefinitionItem[] => {
      const group: SettingDefinitionItem = {
        type: "group",
        heading: section.heading,
        items: [
          // A group heading takes text only, so a section's own words ride in a nameless row
          // at the top of it: nothing to find by searching, and an empty `render` because a
          // row without one is dropped rather than drawn.
          ...(section.desc
            ? [{ name: "", desc: section.desc, searchable: false, render: () => {} }]
            : []),
          ...section.entries.map(toDefinition),
        ],
      };
      const { list } = section;
      if (!list) return [group];
      // The list follows its section rather than sitting inside it: a group holds settings,
      // a list holds the items, and Obsidian renders each in its own style.
      return [group, {
        type: "list",
        heading: list.heading,
        emptyState: list.emptyState,
        onReorder: list.onReorder,
        onDelete: list.onDelete,
        addItem: { name: list.addName, action: () => list.add() },
        items: list.entries(false).map(toDefinition),
      }];
    });
  }

  // The render path for Obsidian < 1.13.0, which drives the tab through display().
  // It walks the same sections, so both paths stay in step by construction. Here a
  // heading is a row of its own, and the CSS joins the rows under it into one block.
  // @deprecated on 1.13.0+ — kept intentionally per minAppVersion 1.12.7.
  display(): void {
    const { containerEl } = this;
    const scrollTop = containerEl.scrollTop;
    containerEl.empty();
    for (const section of this.buildSections()) {
      const heading = new Setting(containerEl).setName(section.heading).setHeading();
      if (section.desc) heading.setDesc(section.desc);
      // A list is plain rows here, each carrying the affordances 1.13.0+ draws for itself.
      const rows = section.list
        ? [...section.entries, ...section.list.entries(true), addRow(section.list)]
        : section.entries;
      let lastRow: Setting | undefined;
      for (const entry of rows) {
        const setting = new Setting(containerEl);
        if (entry.name) setting.setName(entry.name);
        if (entry.desc) setting.setDesc(entry.desc);
        renderRow(entry, setting);
        lastRow = setting;
      }
      // Closes the block: CSS can look back at the row before but not ahead to the heading
      // that ends the run, so the last row of the section says so itself.
      lastRow?.settingEl.addClass("pm-setting-row--run-end");
    }
    containerEl.scrollTop = scrollTop;
  }

  // Re-render after a settings change: through update() on 1.13.0+, which is where the
  // declarative pipeline exists, and through display() on 1.12.x.
  private rerender(): void {
    if (requireApiVersion("1.13.0")) {
      this.update();
    } else {
      // Called through a cast so it isn't the deprecated symbol the obsidian types
      // flag — this repo's eslint config bans disabling that rule.
      (this as unknown as { display: () => void }).display();
    }
  }

  /** A message row: something the section can't do until the vault is set up for it. */
  private warningEntry(name: string, desc: string): SettingEntry {
    return {
      name,
      desc,
      build: (setting) => setting.settingEl.addClass("pm-setting--warning"),
    };
  }

  /** A whole-number field, picked rather than typed: the input refuses anything but digits
   *  and offers a numeric keypad on a phone. An emptied field keeps the stored value, so an
   *  edit in progress can't clear the setting, and the field shows that value again on blur. */
  private numberEntry(name: string, desc: string, key: SettingKeyOf<number>): SettingEntry {
    return {
      name,
      desc,
      build: (setting) => {
        // A day count needs a handful of characters, not the width of a vault path.
        setting.settingEl.addClass("pm-setting--number");

        const commit = async (value: string) => {
          const n = parseInt(value, 10);
          if (!Number.isFinite(n) || n < 0) return;
          // Through a Record view: an indexed write to a union of keys needs one.
          (this.plugin.settings as Record<SettingKeyOf<number>, number>)[key] = n;
          await this.plugin.saveSettings();
        };

        let input!: HTMLInputElement;
        setting.addText((text) => {
          input = text.inputEl;
          input.type = "number";
          input.min = "0";
          input.step = "1";
          text.setValue(String(this.plugin.settings[key])).onChange(commit);
          // A refused value ("-1" survives `type="number"`) would otherwise sit there
          // looking saved. On blur only: mid-edit it would fight a field being retyped.
          input.addEventListener("blur", () => {
            input.value = String(this.plugin.settings[key]);
          });
        });

        // Obsidian hides the input's own spinner, and a phone shows none at all, so the
        // steppers are ours. They move the field, which is what gets saved.
        const stepper = (icon: Icon, tooltip: string, delta: 1 | -1) => {
          let el!: HTMLElement;
          setting.addExtraButton((btn) => {
            el = btn.extraSettingsEl;
            btn
              .setIcon(icon)
              .setTooltip(tooltip)
              .onClick(() => {
                const next = Math.max(0, this.plugin.settings[key] + delta);
                input.value = String(next);
                void commit(input.value);
              });
          });
          return el;
        };
        // Obsidian only appends, so "less" is put back where it reads: below the value
        // on its left, above it on its right.
        const less = stepper(Icon.StepDown, "Less", -1);
        stepper(Icon.StepUp, "More", 1);
        setting.controlEl.insertBefore(less, input);
        return setting;
      },
    };
  }

  /** A text field, trimmed on the way in. An empty value falls back to `fallback`, which
   *  doubles as the placeholder unless `placeholder` says otherwise. */
  private textEntry(
    name: string,
    desc: string,
    key: SettingKeyOf<string>,
    opts: {
      fallback?: string;
      placeholder?: string;
      disabled?: boolean;
      /** Applied after the trim — the habits tag drops a leading `#`. */
      clean?: (value: string) => string;
    } = {},
  ): SettingEntry {
    const fallback = opts.fallback ?? "";
    return {
      name,
      desc,
      build: (setting) => {
        // Obsidian styles a disabled input no differently from an editable one, so the
        // row says it for itself.
        if (opts.disabled) setting.settingEl.addClass("pm-setting--disabled");
        return setting.addText((text) =>
          text
            .setPlaceholder(opts.placeholder ?? fallback)
            .setValue(this.plugin.settings[key])
            .setDisabled(opts.disabled ?? false)
            .onChange(async (value) => {
              const cleaned = opts.clean ? opts.clean(value.trim()) : value.trim();
              (this.plugin.settings as Record<SettingKeyOf<string>, string>)[key] =
                cleaned || fallback;
              await this.plugin.saveSettings();
            }),
        );
      },
    };
  }

  /** An on/off field. `after` runs once the new value is saved, for the settings a view
   *  has to be told about. */
  private toggleEntry(
    name: string, desc: string, key: SettingKeyOf<boolean>, after?: () => void,
  ): SettingEntry {
    return {
      name,
      desc,
      build: (setting) =>
        setting.addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings[key])
            .onChange(async (value) => {
              (this.plugin.settings as Record<SettingKeyOf<boolean>, boolean>)[key] = value;
              await this.plugin.saveSettings();
              after?.();
            }),
        ),
    };
  }

  private buildSections(): SettingSection[] {
    void this.refreshDayNotesState();

    return [
      {
        heading: "General",
        entries: [
          this.toggleEntry(
            "Split the task lists into sections",
            "Group the dashboard's tasks under headings by horizon. When disabled, each group is one " +
            "list, in the same order.",
            "splitTaskLists",
            () => this.plugin.refreshDashboard(),
          ),
          this.toggleEntry(
            "Merge daily and project tasks",
            "Hold the daily note's checklist items and the project tasks of the same horizon in shared " +
            "sections, instead of each keeping its own.",
            "mergeDailyAndProjectTasks",
            () => this.plugin.refreshDashboard(),
          ),
        ],
      },
      {
        heading: "Project manager integration",
        entries: [
          this.toggleEntry(
            "Automatically synchronize Obsidian-pm parameters",
            "Read the projects folder from Obsidian-pm settings at startup.",
            "syncObsidianPmSettings",
            // The projects folder below is disabled by this, so the tab is rebuilt.
            () => this.rerender(),
          ),
          this.textEntry(
            "Projects folder",
            "Vault-relative path to the folder holding the Obsidian-pm project files. " +
            "Read-only while the synchronization above is on.",
            "projectsFolder",
            { fallback: "Projects", disabled: this.plugin.settings.syncObsidianPmSettings },
          ),
          this.toggleEntry(
            "Check project listings when the dashboard opens",
            "Bring every project and task's checklist back into line with the tasks that exist. " +
            "When disabled, each note is checked the first time it changes instead — turn it off if " +
            "opening the dashboard takes too long.",
            "verifyListingsOnLoad",
          ),
        ],
      },
      {
        heading: "Daily notes integration",
        entries: [
          ...(this.dayNotesBlocked ? [this.warningEntry(
            "No day note can be created",
            "The daily notes core plugin is off and has left no folder or format behind, so there is " +
            "nowhere to put one. Existing day notes are still read. Turn the plugin on under Core " +
            "plugins.",
          )] : []),
          this.textEntry(
            "Inbox file",
            "Vault-relative path to the inbox Markdown file. Leave empty to use the daily notes folder.",
            "inboxFilePath",
            { placeholder: "Daily Notes/Inbox.md" },
          ),
          this.numberEntry(
            "Inbox — stale task threshold (days)",
            "Days after which an inbox task is flagged as stale (0 to disable).",
            "inboxStaleAfterDays",
          ),
          this.numberEntry(
            "Unclosed items — days before",
            "Past days scanned for unclosed checklist items (0 to disable).",
            "unclosedDaysBefore",
          ),
          this.numberEntry(
            "Unclosed items — days after",
            "Upcoming days scanned for unclosed checklist items (0 to disable).",
            "unclosedDaysAfter",
          ),
          this.textEntry(
            "Scheduled task heading",
            "Heading a task lands under when scheduled for a day. Added at the end of that day's note " +
            "when it isn't there.",
            "dailyTasksHeading",
            { fallback: "# Tasks" },
          ),
        ],
      },
      this.recurringTasksSection(),
      {
        heading: "Confirmations",
        entries: [
          this.toggleEntry(
            "Ask before deleting a task or item",
            "Covers a project task and the subtasks under it, an inbox item, a day checklist item " +
            "and a habit.",
            "confirmDeletes",
          ),
          this.toggleEntry(
            "Ask before removing a note",
            "A note's nested checklist items go with it, which is what the question warns about.",
            "confirmNoteRemoval",
          ),
          this.toggleEntry(
            "Ask before moving a task by drag and drop",
            "Dropping a card on another one, or on a breadcrumb entry, in the task graph.",
            "confirmTaskMoves",
          ),
          this.toggleEntry(
            "Ask before removing a dependency",
            "Removing a link from the menu on a dependency's line in the task graph.",
            "confirmDependencyRemoval",
          ),
          this.toggleEntry(
            "Ask before resetting the graph layout",
            "\"Reset layout\" drops the card position and size stored on every task note, so the " +
            "question names how many it would edit.",
            "confirmLayoutReset",
          ),
        ],
      },
    ];
  }

  private recurringTasksSection(): SettingSection {
    const sorted = [...this.plugin.settings.recurringTasks].sort((a, b) => a.order - b.order);
    return {
      heading: "Recurring daily habits",
      desc:
        "Habits inserted automatically into each day's note. Renaming a habit's title retires the old " +
        "one for tracking purposes — existing note lines keep their original text.",
      entries: [
        this.textEntry(
          "Habits section heading",
          "Heading the recurring habits land under in each daily note. Added at the end of the note " +
          "when it isn't there.",
          "recurringTasksHeading",
          { fallback: "# Routine" },
        ),
        this.textEntry(
          "Daily habits tag",
          "Applied to every habit line, and used to spot habit items in the week summary. Example: #daily",
          "dailyHabitsTag",
          // The fallback is the literal default tag, not prose: "Daily" would imply `#Daily`.
          { fallback: "daily", clean: (value) => value.replace(/^#/, "") },
        ),
      ],
      list: {
        heading: "Habits",
        entries: (ownAffordances) => sorted.map((def) => ({
          name: def.title,
          aliases: def.detail ? [def.detail] : undefined,
          build: (setting: Setting) =>
            this.buildRecurringTaskRow(setting, def, sorted, ownAffordances),
        })),
        addName: "Add a habit",
        add: () => void this.addHabit(),
        onReorder: (from, to) => void this.moveHabit(sorted, from, to),
        onDelete: (index) => this.deleteHabit(sorted[index]),
        emptyState: "No habits yet.",
      },
    };
  }

  /** A new habit, at the end of the list. */
  private async addHabit(): Promise<void> {
    const maxOrder = this.plugin.settings.recurringTasks.reduce((m, d) => Math.max(m, d.order), -1);
    const newDef: RecurringTaskDefinition = {
      id: crypto.randomUUID(),
      title: "New habit",
      weekdays: ALL_WEEKDAYS,
      order: maxOrder + 1,
      active: true,
      createdAt: startOfDay(new Date()),
      detail: "",
    };
    this.plugin.settings.recurringTasks = [...this.plugin.settings.recurringTasks, newDef];
    await this.plugin.saveSettings();
    this.rerender();
  }

  /** Moves a habit to another position and renumbers the whole run, which serves a drag
   *  across the list and a step to the neighbour alike. */
  private async moveHabit(
    sorted: RecurringTaskDefinition[],
    from: number,
    to: number,
  ): Promise<void> {
    const moved = sorted[from];
    if (!moved || to < 0 || to >= sorted.length) return;
    const order = [...sorted];
    order.splice(from, 1);
    order.splice(to, 0, moved);
    order.forEach((def, index) => { def.order = index; });
    await this.plugin.saveSettings();
    this.rerender();
  }

  private deleteHabit(def: RecurringTaskDefinition | undefined): void {
    if (!def) return;
    confirmAction(
      this.app,
      this.plugin.settings.confirmDeletes,
      `Delete "${def.title}"?`,
      () => {
        this.plugin.settings.recurringTasks = this.plugin.settings.recurringTasks.filter(
          (d) => d.id !== def.id,
        );
        void this.plugin.saveSettings().then(() => this.rerender());
      },
    );
  }

  private buildRecurringTaskRow(
    row: Setting,
    def: RecurringTaskDefinition,
    sorted: RecurringTaskDefinition[],
    ownAffordances: boolean,
  ): void {
    row.settingEl.addClass("pm-recurring-task-row");

    // A plain always-editable input, the same widget as the heading fields above.
    row.nameEl.empty();
    row.nameEl.addClass("pm-recurring-task-title");
    const titleInput = row.nameEl.createEl("input", {
      type: "text",
      cls: "pm-recurring-task-title-input",
      attr: { title: "Enter to save, esc to cancel" },
    });
    titleInput.value = def.title;

    // Blur or Enter commits the rename, Escape rolls back. An unchanged or blank value
    // reverts the input in place rather than re-rendering, keeping the scroll position.
    wireCommitOnKey(
      titleInput,
      (ke) => ke.key === "Enter",
      () => {
        const newTitle = titleInput.value.trim();
        if (newTitle && newTitle !== def.title) {
          def.title = newTitle;
          void this.plugin.saveSettings().then(() => this.rerender());
        } else {
          titleInput.value = def.title;
        }
      },
      () => {
        titleInput.value = def.title;
      },
    );

    // The active toggle sits on the title line, not with the actions: it governs the
    // whole definition, and keeps the weekday row it greys out directly beneath it.
    new ToggleComponent(row.nameEl).setValue(def.active).onChange(async (value) => {
      def.active = value;
      await this.plugin.saveSettings();
      this.rerender();
    });

    const dayButtonEls: HTMLElement[] = [];
    for (let i = 0; i < 7; i++) {
      const scheduled = (def.weekdays & (1 << i)) !== 0;
      row.addButton((btn) => {
        dayButtonEls.push(btn.buttonEl);
        btn.setButtonText(WEEKDAY_LABELS[i]);
        if (scheduled) btn.setCta();
        btn.onClick(async () => {
          def.weekdays ^= 1 << i;
          await this.plugin.saveSettings();
          this.rerender();
        });
      });
    }

    if (ownAffordances) {
      const index = sorted.indexOf(def);
      const addMoveButton = (icon: Icon, tooltip: string, step: -1 | 1) => {
        const to = index + step;
        row.addExtraButton((btn) =>
          btn
            .setIcon(icon)
            .setTooltip(tooltip)
            .setDisabled(to < 0 || to >= sorted.length)
            .onClick(() => void this.moveHabit(sorted, index, to)),
        );
      };
      addMoveButton(Icon.MoveUp, "Move up", -1);
      addMoveButton(Icon.MoveDown, "Move down", 1);
    }
    row.addExtraButton((btn) =>
      btn
        .setIcon(Icon.EditRecurringTask)
        .setTooltip("Edit")
        .onClick(() => {
          new RecurringTaskModal(this.app, def, (result) => {
            def.title = result.title;
            def.detail = result.detail;
            void this.plugin.saveSettings().then(() => this.rerender());
          }).open();
        }),
    );
    if (ownAffordances) {
      row.addExtraButton((btn) =>
        btn
          .setIcon(Icon.DeleteRecurringTask)
          .setTooltip("Delete")
          .onClick(() => this.deleteHabit(def)),
      );
    }

    // Obsidian's components only append to `controlEl`, which a phone lays out as one
    // full-width row per control. Regrouping them into an explicit weekday row and action
    // row lets the CSS give a narrow screen `title / Mo–Su / actions`.
    const daysEl = createDiv({ cls: "pm-recurring-task-days" });
    if (!def.active) daysEl.addClass("pm-recurring-task-days--inactive");
    for (const btnEl of dayButtonEls) daysEl.appendChild(btnEl);
    const actionsEl = createDiv({ cls: "pm-recurring-task-actions" });
    while (row.controlEl.firstChild) actionsEl.appendChild(row.controlEl.firstChild);
    row.controlEl.append(daysEl, actionsEl);

    // A list draws its drag handle and delete button into `controlEl` after this callback
    // has run, which would leave them below the action row a phone stacks — and outside it
    // on any screen. Whatever lands there later joins the actions instead.
    if (!ownAffordances) {
      const observer = new MutationObserver((records) => {
        // A re-render empties `controlEl` and builds the row again, weekday and action rows
        // and all. This observer belongs to the render that has just been replaced, so it
        // stands down rather than claim the new action row's children for its detached one.
        if (actionsEl.parentElement !== row.controlEl) {
          observer.disconnect();
          return;
        }
        for (const record of records) {
          for (const node of Array.from(record.addedNodes)) {
            if (node !== daysEl && node !== actionsEl) actionsEl.appendChild(node);
          }
        }
      });
      observer.observe(row.controlEl, { childList: true });
    }
  }
}
