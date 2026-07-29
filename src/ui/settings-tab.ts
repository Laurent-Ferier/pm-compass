import { App, PluginSettingTab, Setting, ToggleComponent, requireApiVersion } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import { Icon } from "./icons";
import type PMCompassPlugin from "../main";
import type { PMCompassSettings } from "../model/settings";
import { startOfDay } from "../model/dates";
import { ALL_WEEKDAYS, type RecurringTaskDefinition } from "../model/daily/recurring-task";
import { RecurringTaskModal } from "./recurring-task-modal";
import { wireCommitOnKey } from "./inline-edit";

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

export class PMCompassSettingTab extends PluginSettingTab {
  plugin: PMCompassPlugin;

  constructor(app: App, plugin: PMCompassPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Obsidian 1.13.0+ renders the tab from these and indexes them for the settings
  // search. Each entry builds its own widget in a `render` callback.
  getSettingDefinitions(): SettingDefinitionItem[] {
    return this.buildEntries().map((entry) => ({
      name: entry.name,
      desc: entry.desc,
      aliases: entry.aliases,
      render: (setting: Setting) => {
        if (entry.heading) setting.setHeading();
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
      if (entry.heading) setting.setHeading();
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

  private buildEntries(): SettingEntry[] {
    const entries: SettingEntry[] = [];

    entries.push({
      name: "Project manager integration",
      heading: true,
      build: () => {},
    });

    entries.push({
      name: "Automatically synchronize Obsidian-pm parameters",
      desc: "When enabled, the projects folder is read from Obsidian-pm settings at startup.",
      build: (setting) =>
        setting.addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.syncObsidianPmSettings)
            .onChange(async (value) => {
              this.plugin.settings.syncObsidianPmSettings = value;
              await this.plugin.saveSettings();
              this.rerender();
            }),
        ),
    });

    entries.push({
      name: "Projects folder",
      desc: "Vault-relative path to the folder containing Obsidian-pm project files.",
      build: (setting) =>
        setting.addText((text) =>
          text
            .setPlaceholder("Projects")
            .setValue(this.plugin.settings.projectsFolder)
            .setDisabled(this.plugin.settings.syncObsidianPmSettings)
            .onChange(async (value) => {
              this.plugin.settings.projectsFolder = value.trim() || "Projects";
              await this.plugin.saveSettings();
            }),
        ),
    });

    entries.push({
      name: "Daily notes integration",
      heading: true,
      build: () => {},
    });

    entries.push({
      name: "Inbox file",
      desc: "Vault-relative path to the inbox Markdown file. Leave empty to use the daily notes folder (e.g. Daily notes/inbox.md).",
      build: (setting) =>
        setting.addText((text) =>
          text
            .setPlaceholder("Daily Notes/Inbox.md")
            .setValue(this.plugin.settings.inboxFilePath)
            .onChange(async (value) => {
              this.plugin.settings.inboxFilePath = value.trim();
              await this.plugin.saveSettings();
            }),
        ),
    });

    entries.push({
      name: "Inbox — stale task threshold (days)",
      desc: "Number of days after which an inbox task is considered stale and shown with a warning indicator (0 to disable).",
      build: (setting) =>
        setting.addText((text) =>
          text
            .setPlaceholder("7")
            .setValue(String(this.plugin.settings.inboxStaleAfterDays))
            .onChange(async (value) => {
              const n = parseInt(value, 10);
              this.plugin.settings.inboxStaleAfterDays = Number.isFinite(n) && n >= 0 ? n : 7;
              await this.plugin.saveSettings();
            }),
        ),
    });

    entries.push({
      name: "Unclosed items — days before",
      desc: "Number of past days to scan for unclosed checklist items in the dashboard (0 to disable).",
      build: (setting) =>
        setting.addText((text) =>
          text
            .setPlaceholder("7")
            .setValue(String(this.plugin.settings.unclosedDaysBefore))
            .onChange(async (value) => {
              const n = parseInt(value, 10);
              this.plugin.settings.unclosedDaysBefore = Number.isFinite(n) && n >= 0 ? n : 7;
              await this.plugin.saveSettings();
            }),
        ),
    });

    entries.push({
      name: "Unclosed items — days after",
      desc: "Number of upcoming days to scan for unclosed checklist items in the dashboard (0 to disable).",
      build: (setting) =>
        setting.addText((text) =>
          text
            .setPlaceholder("7")
            .setValue(String(this.plugin.settings.unclosedDaysAfter))
            .onChange(async (value) => {
              const n = parseInt(value, 10);
              this.plugin.settings.unclosedDaysAfter = Number.isFinite(n) && n >= 0 ? n : 7;
              await this.plugin.saveSettings();
            }),
        ),
    });

    entries.push({
      name: "Merge daily and project tasks",
      desc:
        "When enabled, the dashboard shows \"Overdue\", \"Current\" and \"Next up\" sections, each holding both " +
        "the daily note's checklist items and the project tasks of that horizon. When disabled, daily tasks " +
        "and project tasks keep their own sections.",
      build: (setting) =>
        setting.addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.mergeDailyAndProjectTasks)
            .onChange(async (value) => {
              this.plugin.settings.mergeDailyAndProjectTasks = value;
              await this.plugin.saveSettings();
              this.plugin.refreshDashboard();
            }),
        ),
    });

    entries.push({
      name: "Check project listings when the dashboard opens",
      desc:
        "Brings every project's \"Tasks\" checklist and every parent task's \"Subtasks\" checklist back into " +
        "line with the tasks that exist: entries added, titles refreshed, boxes matched to statuses. " +
        "When disabled, each note is checked the first time it changes instead — the only cost being that " +
        "the first box you tick in a note goes towards checking it rather than closing that task.",
      build: (setting) =>
        setting.addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.verifyListingsOnLoad)
            .onChange(async (value) => {
              this.plugin.settings.verifyListingsOnLoad = value;
              await this.plugin.saveSettings();
            }),
        ),
    });

    entries.push({
      name: "Split the task lists into sections",
      desc:
        "When enabled, the dashboard groups its tasks under headings: \"Overdue\", \"Current\" and \"Next up\" " +
        "while daily and project tasks are merged; otherwise \"Overdue tasks\", the day's checklist and " +
        "\"Upcoming tasks\", plus \"Approaching Deadlines\" and \"Priority Queue\" for the project tasks. " +
        "When disabled, each group is one list, in the same order.",
      build: (setting) =>
        setting.addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.splitTaskLists)
            .onChange(async (value) => {
              this.plugin.settings.splitTaskLists = value;
              await this.plugin.saveSettings();
              this.plugin.refreshDashboard();
            }),
        ),
    });

    entries.push({
      name: "Scheduled task heading",
      desc:
        "The Markdown heading under which a task lands when scheduled/rescheduled to a day from the " +
        "Inbox or Dashboard, instead of just being appended at the end of that day's note.",
      build: (setting) =>
        setting.addText((text) =>
          text
            .setPlaceholder("# Tasks")
            .setValue(this.plugin.settings.dailyTasksHeading)
            .onChange(async (value) => {
              this.plugin.settings.dailyTasksHeading = value.trim() || "# Tasks";
              await this.plugin.saveSettings();
            }),
        ),
    });

    this.pushRecurringTasksEntries(entries);

    return entries;
  }

  private pushRecurringTasksEntries(entries: SettingEntry[]): void {
    entries.push({
      name: "Recurring daily habits",
      desc:
        "Habits inserted automatically into each day's note. Renaming a habit's title retires the old " +
        "one for tracking purposes — existing note lines keep their original text.",
      heading: true,
      build: () => {},
    });

    entries.push({
      name: "Habits section heading",
      desc: "The Markdown heading under which recurring habits are inserted/expected in each daily note.",
      build: (setting) =>
        setting.addText((text) =>
          text
            .setPlaceholder("# Routine")
            .setValue(this.plugin.settings.recurringTasksHeading)
            .onChange(async (value) => {
              this.plugin.settings.recurringTasksHeading = value.trim() || "# Routine";
              await this.plugin.saveSettings();
            }),
        ),
    });

    entries.push({
      name: "Daily habits tag",
      desc: "Applied to every recurring habit line, and used to identify habit items in the week summary. Example: #daily",
      build: (setting) =>
        setting.addText((text) =>
          text
            // Not prose: the literal default tag value. "Daily" would imply `#Daily`.
            .setPlaceholder("daily")
            .setValue(this.plugin.settings.dailyHabitsTag)
            .onChange(async (value) => {
              this.plugin.settings.dailyHabitsTag = value.trim().replace(/^#/, "") || "daily";
              await this.plugin.saveSettings();
            }),
        ),
    });

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
    row.addExtraButton((btn) =>
      btn
        .setIcon(Icon.MoveUp)
        .setTooltip("Move up")
        .setDisabled(index === 0)
        .onClick(async () => {
          if (index <= 0) return;
          const other = sorted[index - 1];
          [def.order, other.order] = [other.order, def.order];
          await this.plugin.saveSettings();
          this.rerender();
        }),
    );
    row.addExtraButton((btn) =>
      btn
        .setIcon(Icon.MoveDown)
        .setTooltip("Move down")
        .setDisabled(index === sorted.length - 1)
        .onClick(async () => {
          if (index >= sorted.length - 1) return;
          const other = sorted[index + 1];
          [def.order, other.order] = [other.order, def.order];
          await this.plugin.saveSettings();
          this.rerender();
        }),
    );
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
