import { App, PluginSettingTab, Setting } from "obsidian";
import type PMCompassPlugin from "../main";
import type { PMCompassSettings } from "../model/settings";
import { ALL_WEEKDAYS, type RecurringTaskDefinition } from "../model/recurring-task";
import { RecurringTaskModal } from "./recurring-task-modal";
import { wireCommitOnKey } from "./inline-edit";

const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

export class PMCompassSettingTab extends PluginSettingTab {
  plugin: PMCompassPlugin;

  constructor(app: App, plugin: PMCompassPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    const scrollTop = containerEl.scrollTop;
    containerEl.empty();
    new Setting(containerEl)
      .setName(`PM Compass v${this.plugin.manifest.version}`)
      .setHeading();

    new Setting(containerEl)
      .setName("Project Manager integration")
      .setHeading();

    new Setting(containerEl)
      .setName("Automatically synchronize obsidian-pm parameters")
      .setDesc(
        "When enabled, the projects folder is read from obsidian-pm settings at startup.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncObsidianPmSettings)
          .onChange(async (value) => {
            this.plugin.settings.syncObsidianPmSettings = value;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("Projects folder")
      .setDesc(
        "Vault-relative path to the folder containing obsidian-pm project files.",
      )
      .addText((text) =>
        text
          .setPlaceholder("Projects")
          .setValue(this.plugin.settings.projectsFolder)
          .setDisabled(this.plugin.settings.syncObsidianPmSettings)
          .onChange(async (value) => {
            this.plugin.settings.projectsFolder = value.trim() || "Projects";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Daily Notes integration")
      .setHeading();

    new Setting(containerEl)
      .setName("Inbox file")
      .setDesc(
        "Vault-relative path to the Inbox markdown file. Leave empty to use the Daily Notes folder (e.g. Daily Notes/Inbox.md).",
      )
      .addText((text) =>
        text
          .setPlaceholder("Daily Notes/Inbox.md")
          .setValue(this.plugin.settings.inboxFilePath)
          .onChange(async (value) => {
            this.plugin.settings.inboxFilePath = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Inbox — stale task threshold (days)")
      .setDesc(
        "Number of days after which an inbox task is considered stale and shown with a warning indicator (0 to disable).",
      )
      .addText((text) =>
        text
          .setPlaceholder("7")
          .setValue(String(this.plugin.settings.inboxStaleAfterDays))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.inboxStaleAfterDays = Number.isFinite(n) && n >= 0 ? n : 7;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Unclosed items — days before")
      .setDesc(
        "Number of past days to scan for unclosed checklist items in the dashboard (0 to disable).",
      )
      .addText((text) =>
        text
          .setPlaceholder("7")
          .setValue(String(this.plugin.settings.unclosedDaysBefore))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.unclosedDaysBefore = Number.isFinite(n) && n >= 0 ? n : 7;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Unclosed items — days after")
      .setDesc(
        "Number of upcoming days to scan for unclosed checklist items in the dashboard (0 to disable).",
      )
      .addText((text) =>
        text
          .setPlaceholder("7")
          .setValue(String(this.plugin.settings.unclosedDaysAfter))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.unclosedDaysAfter = Number.isFinite(n) && n >= 0 ? n : 7;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Small task planning window (weeks ahead)")
      .setDesc(
        "Non-habit checklist items can only be scheduled/rescheduled up to this many weeks " +
          "ahead of the current week (0 to disable).",
      )
      .addText((text) =>
        text
          .setPlaceholder("1")
          .setValue(String(this.plugin.settings.smallTaskMaxWeeksAhead))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.smallTaskMaxWeeksAhead = Number.isFinite(n) && n >= 0 ? n : 1;
            await this.plugin.saveSettings();
          }),
      );

    this.displayRecurringTasksSection(containerEl);

    containerEl.scrollTop = scrollTop;
  }

  private displayRecurringTasksSection(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Recurring daily habits")
      .setDesc(
        "Habits inserted automatically into each day's note. Renaming a habit's title retires the old " +
          "one for tracking purposes — existing note lines keep their original text.",
      )
      .setHeading();

    new Setting(containerEl)
      .setName("Habits section heading")
      .setDesc(
        "The Markdown heading under which recurring habits are inserted/expected in each daily note.",
      )
      .addText((text) =>
        text
          .setPlaceholder("# Routine")
          .setValue(this.plugin.settings.recurringTasksHeading)
          .onChange(async (value) => {
            this.plugin.settings.recurringTasksHeading = value.trim() || "# Routine";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Daily habits tag")
      .setDesc(
        "Applied to every recurring habit line, and used to identify habit items in the Week Summary. Example: #daily",
      )
      .addText((text) =>
        text
          .setPlaceholder("daily")
          .setValue(this.plugin.settings.dailyHabitsTag)
          .onChange(async (value) => {
            this.plugin.settings.dailyHabitsTag = value.trim().replace(/^#/, "") || "daily";
            await this.plugin.saveSettings();
          }),
      );

    const sorted = [...this.plugin.settings.recurringTasks].sort((a, b) => a.order - b.order);
    for (const def of sorted) {
      this.displayRecurringTaskRow(containerEl, def, sorted);
    }

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText("+ Add habit")
        .onClick(async () => {
          const maxOrder = this.plugin.settings.recurringTasks.reduce((m, d) => Math.max(m, d.order), -1);
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
          await this.plugin.saveSettings();
          this.display();
        }),
    );
  }

  private displayRecurringTaskRow(
    containerEl: HTMLElement,
    def: RecurringTaskDefinition,
    sorted: RecurringTaskDefinition[],
  ): void {
    const row = new Setting(containerEl)
      .setName(def.title)
      .setDesc(def.active ? "" : "(inactive)");
    row.settingEl.addClass("pm-recurring-task-row");

    row.nameEl.addClass("pm-recurring-task-title");
    row.nameEl.setAttribute("tabindex", "0");
    row.nameEl.setAttribute("role", "button");
    row.nameEl.setAttribute("aria-label", "Click to rename");
    const startInlineEdit = () => {
      row.nameEl.empty();
      const input = row.nameEl.createEl("input", {
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
            void this.plugin.saveSettings().then(() => this.display());
          } else {
            this.display();
          }
        },
        () => this.display(),
      );
    };
    row.nameEl.addEventListener("click", startInlineEdit);
    row.nameEl.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        startInlineEdit();
      }
    });

    for (let i = 0; i < 7; i++) {
      const scheduled = (def.weekdays & (1 << i)) !== 0;
      row.addButton((btn) => {
        btn.setButtonText(WEEKDAY_LABELS[i]);
        if (scheduled) btn.setCta();
        btn.onClick(async () => {
          def.weekdays ^= 1 << i;
          await this.plugin.saveSettings();
          this.display();
        });
      });
    }

    row.addToggle((toggle) =>
      toggle.setValue(def.active).onChange(async (value) => {
        def.active = value;
        await this.plugin.saveSettings();
        this.display();
      }),
    );

    const index = sorted.indexOf(def);
    row.addExtraButton((btn) =>
      btn
        .setIcon("arrow-up")
        .setTooltip("Move up")
        .setDisabled(index === 0)
        .onClick(async () => {
          if (index <= 0) return;
          const other = sorted[index - 1];
          [def.order, other.order] = [other.order, def.order];
          await this.plugin.saveSettings();
          this.display();
        }),
    );
    row.addExtraButton((btn) =>
      btn
        .setIcon("arrow-down")
        .setTooltip("Move down")
        .setDisabled(index === sorted.length - 1)
        .onClick(async () => {
          if (index >= sorted.length - 1) return;
          const other = sorted[index + 1];
          [def.order, other.order] = [other.order, def.order];
          await this.plugin.saveSettings();
          this.display();
        }),
    );
    row.addExtraButton((btn) =>
      btn
        .setIcon("pencil")
        .setTooltip("Edit")
        .onClick(() => {
          new RecurringTaskModal(this.app, def, async (result) => {
            def.title = result.title;
            def.detail = result.detail;
            await this.plugin.saveSettings();
            this.display();
          }).open();
        }),
    );
    row.addExtraButton((btn) =>
      btn
        .setIcon("trash")
        .setTooltip("Delete")
        .onClick(async () => {
          this.plugin.settings.recurringTasks = this.plugin.settings.recurringTasks.filter(
            (d) => d.id !== def.id,
          );
          await this.plugin.saveSettings();
          this.display();
        }),
    );
  }
}

// Re-export for convenience so callers can import PMCompassSettings from this file too
export type { PMCompassSettings };
