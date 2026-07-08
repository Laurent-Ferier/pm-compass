import { App, TFile, normalizePath, moment as _moment } from "obsidian";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moment = _moment as any;
import { DayMarkdownFile, readDailyNotesConfig } from "./day-markdown-file";
import type { PMCompassSettings } from "./settings";
import { weekdayIndexFor } from "./recurring-task";

export interface BackfillResult {
  filesChanged: number;
  filesCreated: number;
}

/**
 * Ensures today and the remaining days of the current ISO week (through Sunday) have
 * their scheduled recurring habits present, creating each daily note (via Templater or
 * raw fallback) if it doesn't exist yet. Days earlier this week that have already
 * passed are intentionally left untouched — adding/changing/removing a habit mid-week
 * should never retroactively rewrite days that are already done.
 */
export async function backfillRecurringHabits(
  app: App,
  settings: PMCompassSettings,
  today: Date = new Date(),
): Promise<BackfillResult> {
  const config = await readDailyNotesConfig(app);
  const weekStart = moment(today).startOf("isoWeek");

  // Ensure the daily-notes folder exists once, up front — DayMarkdownFile.ensure() also
  // checks this, but doing it once here avoids every day's concurrent ensure() call racing
  // to create the same folder.
  if (config.folder) {
    const folderPath = normalizePath(config.folder);
    if (!app.vault.getAbstractFileByPath(folderPath)) {
      await app.vault.createFolder(folderPath);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const days: any[] = [];
  for (let i = weekdayIndexFor(today); i < 7; i++) {
    days.push(moment(weekStart).add(i, "days"));
  }

  // Each day is an independent file, so reconciling them can run concurrently instead of
  // blocking one after another (this runs on every dashboard render, see pm-compass-view.ts).
  const results = await Promise.all(
    days.map(async (day) => {
      const dateStr = day.format(config.format);
      const filePath = normalizePath(
        config.folder ? `${config.folder}/${dateStr}.md` : `${dateStr}.md`,
      );
      const existed = app.vault.getAbstractFileByPath(filePath) instanceof TFile;

      const dmf = await DayMarkdownFile.ensure(app, day, config);
      if (!dmf) return { changed: false, created: false };

      const { inserted, removedCount } = await dmf.reconcileRecurringHabits(
        settings.recurringTasks,
        day.toDate(),
        settings.recurringTasksHeading,
        settings.dailyHabitsTag,
      );
      return { changed: inserted.length > 0 || removedCount > 0, created: !existed };
    }),
  );

  return {
    filesChanged: results.filter((r) => r.changed).length,
    filesCreated: results.filter((r) => r.created).length,
  };
}
