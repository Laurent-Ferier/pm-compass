import {
  App,
  PluginSettingTab,
  Setting,
  type SettingDefinitionItem,
  type SettingGroup,
} from "obsidian";
import type PMCompassPlugin from "../main";
import type { PMCompassSettings } from "../model/settings";
import { ALL_WEEKDAYS, type RecurringTaskDefinition } from "../model/recurring-task";
import { RecurringTaskModal } from "./recurring-task-modal";
import { wireCommitOnKey } from "./inline-edit";

const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** Shared `validate` for the plain non-negative day/week-count settings below. */
function validateNonNegative(value: number): string | undefined {
  return !Number.isFinite(value) || value < 0 ? "Must be a non-negative number" : undefined;
}

export class PMCompassSettingTab extends PluginSettingTab {
  plugin: PMCompassPlugin;

  constructor(app: App, plugin: PMCompassPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // PluginSettingTab declares `display()` as abstract with no runtime implementation, so
  // leaving it unimplemented means `this.display` is `undefined` — but Obsidian's internal
  // tab-opening code still unconditionally calls `tab.display()` before falling back to the
  // declarative getSettingDefinitions() rendering, which throws "e.display is not a function"
  // without this no-op override.
  display(): void {}

  getSettingDefinitions(): SettingDefinitionItem[] {
    // Recomputed on every call (including after update()) so reorder/add/delete of
    // recurring tasks is always reflected immediately.
    const sortedRecurringTasks = [...this.plugin.settings.recurringTasks].sort(
      (a, b) => a.order - b.order,
    );

    return [
      {
        type: "group",
        heading: "Project Manager integration",
        items: [
          {
            name: "Automatically synchronize obsidian-pm parameters",
            desc: "When enabled, the projects folder is read from obsidian-pm settings at startup.",
            control: { type: "toggle", key: "syncObsidianPmSettings" },
          },
          {
            name: "Projects folder",
            desc: "Vault-relative path to the folder containing obsidian-pm project files.",
            control: {
              type: "text",
              key: "projectsFolder",
              placeholder: "Projects",
              disabled: () => this.plugin.settings.syncObsidianPmSettings,
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Daily Notes integration",
        items: [
          {
            name: "Inbox file",
            desc: "Vault-relative path to the Inbox markdown file. Leave empty to use the Daily Notes folder (e.g. Daily Notes/Inbox.md).",
            control: { type: "text", key: "inboxFilePath", placeholder: "Daily Notes/Inbox.md" },
          },
          {
            name: "Inbox — stale task threshold (days)",
            desc: "Number of days after which an inbox task is considered stale and shown with a warning indicator (0 to disable).",
            control: {
              type: "number",
              key: "inboxStaleAfterDays",
              placeholder: "7",
              min: 0,
              validate: validateNonNegative,
            },
          },
          {
            name: "Unclosed items — days before",
            desc: "Number of past days to scan for unclosed checklist items in the dashboard (0 to disable).",
            control: {
              type: "number",
              key: "unclosedDaysBefore",
              placeholder: "7",
              min: 0,
              validate: validateNonNegative,
            },
          },
          {
            name: "Unclosed items — days after",
            desc: "Number of upcoming days to scan for unclosed checklist items in the dashboard (0 to disable).",
            control: {
              type: "number",
              key: "unclosedDaysAfter",
              placeholder: "7",
              min: 0,
              validate: validateNonNegative,
            },
          },
          {
            name: "Small task planning window (weeks ahead)",
            desc:
              "Non-habit checklist items can only be scheduled/rescheduled up to this many weeks " +
              "ahead of the current week (0 to disable).",
            control: {
              type: "number",
              key: "smallTaskMaxWeeksAhead",
              placeholder: "1",
              min: 0,
              validate: validateNonNegative,
            },
          },
          {
            name: "Scheduled task heading",
            desc:
              "The Markdown heading under which a task lands when scheduled/rescheduled to a day from the " +
              "Inbox or Dashboard, instead of just being appended at the end of that day's note.",
            control: { type: "text", key: "dailyTasksHeading", placeholder: "# Tasks" },
          },
        ],
      },
      {
        type: "group",
        heading: "Recurring daily habits",
        items: [
          {
            name: "",
            desc:
              "Habits inserted automatically into each day's note. Renaming a habit's title retires the old " +
              "one for tracking purposes — existing note lines keep their original text.",
            searchable: false,
          },
          {
            name: "Habits section heading",
            desc: "The Markdown heading under which recurring habits are inserted/expected in each daily note.",
            control: { type: "text", key: "recurringTasksHeading", placeholder: "# Routine" },
          },
          {
            name: "Daily habits tag",
            desc: "Applied to every recurring habit line, and used to identify habit items in the Week Summary. Example: #daily",
            control: { type: "text", key: "dailyHabitsTag", placeholder: "daily" },
          },
        ],
      },
      {
        type: "list",
        emptyState: "No habits yet.",
        items: sortedRecurringTasks.map((def) => ({
          name: def.title,
          desc: def.active ? "" : "(inactive)",
          render: (setting: Setting, group: SettingGroup) =>
            this.renderRecurringTaskRow(setting, group, def),
        })),
        onReorder: (oldIndex, newIndex) => {
          const [moved] = sortedRecurringTasks.splice(oldIndex, 1);
          sortedRecurringTasks.splice(newIndex, 0, moved);
          sortedRecurringTasks.forEach((def, index) => {
            def.order = index;
          });
          void this.plugin.saveSettings().then(() => this.update());
        },
        onDelete: (index) => {
          const target = sortedRecurringTasks[index];
          this.plugin.settings.recurringTasks = this.plugin.settings.recurringTasks.filter(
            (d) => d.id !== target.id,
          );
          void this.plugin.saveSettings().then(() => this.update());
        },
        addItem: {
          name: "Add habit",
          action: () => {
            const maxOrder = this.plugin.settings.recurringTasks.reduce(
              (m, d) => Math.max(m, d.order),
              -1,
            );
            const newDef: RecurringTaskDefinition = {
              id: crypto.randomUUID(),
              title: "New habit",
              weekdays: ALL_WEEKDAYS,
              order: maxOrder + 1,
              active: true,
              createdAt: new Date().toISOString().slice(0, 10),
              detail: "",
            };
            this.plugin.settings.recurringTasks = [...this.plugin.settings.recurringTasks, newDef];
            void this.plugin.saveSettings().then(() => this.update());
          },
        },
      },
    ];
  }

  getControlValue(key: string): unknown {
    switch (key) {
      case "syncObsidianPmSettings":
        return this.plugin.settings.syncObsidianPmSettings;
      case "projectsFolder":
        return this.plugin.settings.projectsFolder;
      case "inboxFilePath":
        return this.plugin.settings.inboxFilePath;
      case "inboxStaleAfterDays":
        return this.plugin.settings.inboxStaleAfterDays;
      case "unclosedDaysBefore":
        return this.plugin.settings.unclosedDaysBefore;
      case "unclosedDaysAfter":
        return this.plugin.settings.unclosedDaysAfter;
      case "smallTaskMaxWeeksAhead":
        return this.plugin.settings.smallTaskMaxWeeksAhead;
      case "dailyTasksHeading":
        return this.plugin.settings.dailyTasksHeading;
      case "recurringTasksHeading":
        return this.plugin.settings.recurringTasksHeading;
      case "dailyHabitsTag":
        return this.plugin.settings.dailyHabitsTag;
      default:
        return undefined;
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    switch (key) {
      case "syncObsidianPmSettings":
        this.plugin.settings.syncObsidianPmSettings = value as boolean;
        await this.plugin.saveSettings();
        // The "Projects folder" control's `disabled` predicate depends on this value.
        this.refreshDomState();
        return;
      case "projectsFolder":
        this.plugin.settings.projectsFolder = (value as string).trim() || "Projects";
        break;
      case "inboxFilePath":
        this.plugin.settings.inboxFilePath = (value as string).trim();
        break;
      case "inboxStaleAfterDays":
        this.plugin.settings.inboxStaleAfterDays = value as number;
        break;
      case "unclosedDaysBefore":
        this.plugin.settings.unclosedDaysBefore = value as number;
        break;
      case "unclosedDaysAfter":
        this.plugin.settings.unclosedDaysAfter = value as number;
        break;
      case "smallTaskMaxWeeksAhead":
        this.plugin.settings.smallTaskMaxWeeksAhead = value as number;
        break;
      case "dailyTasksHeading":
        this.plugin.settings.dailyTasksHeading = (value as string).trim() || "# Tasks";
        break;
      case "recurringTasksHeading":
        this.plugin.settings.recurringTasksHeading = (value as string).trim() || "# Routine";
        break;
      case "dailyHabitsTag":
        this.plugin.settings.dailyHabitsTag = (value as string).trim().replace(/^#/, "") || "daily";
        break;
      default:
        return;
    }
    await this.plugin.saveSettings();
  }

  private renderRecurringTaskRow(
    setting: Setting,
    _group: SettingGroup,
    def: RecurringTaskDefinition,
  ): void {
    setting.settingEl.addClass("pm-recurring-task-row");

    setting.nameEl.addClass("pm-recurring-task-title");
    setting.nameEl.setAttribute("tabindex", "0");
    setting.nameEl.setAttribute("role", "button");
    setting.nameEl.setAttribute("aria-label", "Click to rename");
    const startInlineEdit = () => {
      setting.nameEl.empty();
      const input = setting.nameEl.createEl("input", {
        type: "text",
        cls: "pm-recurring-task-title-input",
        attr: { title: "Enter to save, Esc to cancel" },
      });
      input.value = def.title;
      input.focus();
      input.select();

      // Losing focus commits the rename; Enter forces an immediate commit; Escape
      // rolls back without saving.
      wireCommitOnKey(
        input,
        (ke) => ke.key === "Enter",
        () => {
          const newTitle = input.value.trim();
          if (newTitle && newTitle !== def.title) {
            def.title = newTitle;
            void this.plugin.saveSettings().then(() => this.update());
          } else {
            this.update();
          }
        },
        () => this.update(),
      );
    };
    setting.nameEl.addEventListener("click", startInlineEdit);
    setting.nameEl.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        startInlineEdit();
      }
    });

    for (let i = 0; i < 7; i++) {
      const scheduled = (def.weekdays & (1 << i)) !== 0;
      setting.addButton((btn) => {
        btn.setButtonText(WEEKDAY_LABELS[i]);
        if (scheduled) btn.setCta();
        btn.onClick(async () => {
          def.weekdays ^= 1 << i;
          await this.plugin.saveSettings();
          this.update();
        });
      });
    }

    setting.addToggle((toggle) =>
      toggle.setValue(def.active).onChange(async (value) => {
        def.active = value;
        await this.plugin.saveSettings();
        this.update();
      }),
    );

    setting.addExtraButton((btn) =>
      btn
        .setIcon("pencil")
        .setTooltip("Edit")
        .onClick(() => {
          new RecurringTaskModal(this.app, def, async (result) => {
            def.title = result.title;
            def.detail = result.detail;
            await this.plugin.saveSettings();
            this.update();
          }).open();
        }),
    );
  }
}

// Re-export for convenience so callers can import PMCompassSettings from this file too
export type { PMCompassSettings };
