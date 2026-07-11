import { App, TFile, normalizePath } from "obsidian";
import { moment, type Moment } from "./moment";
import { DayMarkdownFile, readDailyNotesConfig } from "./day-markdown-file";
import { ensureFolderRecursive } from "./file-helpers";
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

  const days: Moment[] = [];
  for (let i = weekdayIndexFor(today); i < 7; i++) {
    days.push(moment(weekStart).add(i, "days"));
  }

  // Ensure each day's parent directory exists once, up front — DayMarkdownFile.ensure()
  // also checks this, but doing it here avoids concurrent ensure() calls below racing to
  // create the same folder (the date format can embed slashes, e.g. "YYYY/MM/DD", so
  // multiple days can share a parent directory even when config.folder is blank).
  const parentDirs = new Set<string>();
  for (const day of days) {
    const dateStr = day.format(config.format);
    const filePath = normalizePath(
      config.folder ? `${config.folder}/${dateStr}.md` : `${dateStr}.md`,
    );
    const parentDir = filePath.slice(0, filePath.lastIndexOf("/"));
    if (parentDir) parentDirs.add(parentDir);
  }
  for (const parentDir of parentDirs) {
    await ensureFolderRecursive(app, parentDir);
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
