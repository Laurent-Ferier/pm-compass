import { App, PluginSettingTab, Setting, ToggleComponent, requireApiVersion } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import { Icon } from "./icons";
import type PMCompassPlugin from "../main";
import type { PMCompassSettings } from "../model/settings";
import { startOfDay } from "../model/dates";
import { ALL_WEEKDAYS, type RecurringTaskDefinition } from "../model/daily/recurring-task";
import { RecurringTaskModal } from "./recurring-task-modal";
import { wireCommitOnKey } from "./inline-edit";
import { canCreateDayNotes } from "../model/daily/daily-notes-plugin";

const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

// One unit of the settings tab: its searchable name and description, plus a builder that
// populates the row. The same entries drive both render paths (see buildEntries).
// `heading: true` marks a section header rather than a control row.
interface SettingEntry {
  name: string;
  desc?: string;
  aliases?: string[];
  heading?: boolean;
  build: (setting: Setting) => unknown;
}

/** Marks the rows Obsidian gives a card of its own, which leaves a section looking like a
 *  stack of unrelated tiles: the CSS joins each run of them into one block. Where a run
 *  starts and ends is read off the rendered rows, so a filtered search still rounds off
 *  whatever it leaves standing. */
function applyRowClass(entry: SettingEntry, setting: Setting): void {
  if (entry.heading) setting.setHeading();
  else setting.settingEl.addClass("pm-setting-row");
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
    const blocked = !await canCreateDayNotes(this.app);
    if (blocked === this.dayNotesBlocked) return;
    this.dayNotesBlocked = blocked;
    this.rerender();
  }

  // Obsidian 1.13.0+ renders the tab from these and indexes them for the settings
  // search. Each entry builds its own widget in a `render` callback.
  getSettingDefinitions(): SettingDefinitionItem[] {
    return this.buildEntries().map((entry) => ({
      name: entry.name,
      desc: entry.desc,
      aliases: entry.aliases,
      render: (setting: Setting) => {
        applyRowClass(entry, setting);
        entry.build(setting);
      },
    }));
  }

  // The render path for Obsidian < 1.13.0, which drives the tab through display().
  // It walks the same entries, so both paths stay in step by construction.
  // @deprecated on 1.13.0+ — kept intentionally per minAppVersion 1.12.7.
  display(): void {
    const { containerEl } = this;
    const scrollTop = containerEl.scrollTop;
    containerEl.empty();
    for (const entry of this.buildEntries()) {
      const setting = new Setting(containerEl);
      if (entry.name) setting.setName(entry.name);
      if (entry.desc) setting.setDesc(entry.desc);
      applyRowClass(entry, setting);
      entry.build(setting);
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

  /** A section header: a name and nothing to build. */
  private headingEntry(name: string, desc?: string): SettingEntry {
    return { name, desc, heading: true, build: () => {} };
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

  private buildEntries(): SettingEntry[] {
    void this.refreshDayNotesState();
    const entries: SettingEntry[] = [];

    entries.push(
      this.headingEntry("General"),
      this.toggleEntry(
        "Split the task lists into sections",
        "Group the dashboard's tasks under headings by horizon. When disabled, each group is one list, " +
        "in the same order.",
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

      this.headingEntry("Project manager integration"),
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

      this.headingEntry("Daily notes integration"),
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
    );

    this.pushRecurringTasksEntries(entries);

    return entries;
  }

  private pushRecurringTasksEntries(entries: SettingEntry[]): void {
    entries.push(
      this.headingEntry(
        "Recurring daily habits",
        "Habits inserted automatically into each day's note. Renaming a habit's title retires the old " +
        "one for tracking purposes — existing note lines keep their original text.",
      ),
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
    );

    const sorted = [...this.plugin.settings.recurringTasks].sort((a, b) => a.order - b.order);
    for (const def of sorted) {
      entries.push({
        name: def.title,
        aliases: def.detail ? [def.detail] : undefined,
        build: (setting) => this.buildRecurringTaskRow(setting, def, sorted),
      });
    }

    entries.push({
      name: "",
      aliases: ["add habit", "new habit", "recurring task"],
      build: (setting) =>
        setting.addButton((btn) =>
          btn.setButtonText("+ add habit").onClick(async () => {
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
          }),
        ),
    });
  }

  private buildRecurringTaskRow(
    row: Setting,
    def: RecurringTaskDefinition,
    sorted: RecurringTaskDefinition[],
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

    const index = sorted.indexOf(def);
    // Order is swapped with the neighbour rather than renumbered, so a list only ever
    // touches the two definitions that moved.
    const addMoveButton = (icon: Icon, tooltip: string, step: -1 | 1) => {
      const to = index + step;
      row.addExtraButton((btn) =>
        btn
          .setIcon(icon)
          .setTooltip(tooltip)
          .setDisabled(to < 0 || to >= sorted.length)
          .onClick(async () => {
            const other = sorted[to];
            if (!other) return;
            [def.order, other.order] = [other.order, def.order];
            await this.plugin.saveSettings();
            this.rerender();
          }),
      );
    };
    addMoveButton(Icon.MoveUp, "Move up", -1);
    addMoveButton(Icon.MoveDown, "Move down", 1);
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
    row.addExtraButton((btn) =>
      btn
        .setIcon(Icon.DeleteRecurringTask)
        .setTooltip("Delete")
        .onClick(async () => {
          this.plugin.settings.recurringTasks = this.plugin.settings.recurringTasks.filter(
            (d) => d.id !== def.id,
          );
          await this.plugin.saveSettings();
          this.rerender();
        }),
    );

    // Obsidian's components only append to `controlEl`, which a phone lays out as one
    // full-width row per control. Regrouping them into an explicit weekday row and action
    // row lets the CSS give a narrow screen `title / Mo–Su / actions`.
    const daysEl = createDiv({ cls: "pm-recurring-task-days" });
    if (!def.active) daysEl.addClass("pm-recurring-task-days--inactive");
    for (const btnEl of dayButtonEls) daysEl.appendChild(btnEl);
    const actionsEl = createDiv({ cls: "pm-recurring-task-actions" });
    while (row.controlEl.firstChild) actionsEl.appendChild(row.controlEl.firstChild);
    row.controlEl.append(daysEl, actionsEl);
  }
}

// Re-exported so callers can import PMCompassSettings from this file too.
export type { PMCompassSettings };
