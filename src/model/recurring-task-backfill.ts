import { App, TFile } from "obsidian";
import { addDays, startOfIsoWeek, weekdayIndex } from "./dates";
import { DayMarkdownFile, dayNotePath, readDailyNotesConfig } from "./day-markdown-file";
import { ensureFolderRecursive, parentDirOf } from "./file-helpers";
import type { PMCompassSettings } from "./settings";

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
  const weekStart = startOfIsoWeek(today);

  const days: Date[] = [];
  for (let i = weekdayIndex(today); i < 7; i++) {
    days.push(addDays(weekStart, i));
  }

  // Ensure each day's parent directory exists once, up front — DayMarkdownFile.ensure()
  // also checks this, but doing it here avoids concurrent ensure() calls below racing to
  // create the same folder (the date format can embed slashes, e.g. "YYYY/MM/DD", so
  // multiple days can share a parent directory even when config.folder is blank).
  const parentDirs = new Set<string>();
  for (const day of days) {
    const parentDir = parentDirOf(dayNotePath(day, config));
    if (parentDir) parentDirs.add(parentDir);
  }
  for (const parentDir of parentDirs) {
    await ensureFolderRecursive(app, parentDir);
  }

  // Each day is an independent file, so reconciling them can run concurrently instead of
  // blocking one after another (this runs on every dashboard render, see pm-compass-view.ts).
  const results = await Promise.all(
    days.map(async (day) => {
      const filePath = dayNotePath(day, config);
      const existed = app.vault.getAbstractFileByPath(filePath) instanceof TFile;

      const dmf = await DayMarkdownFile.ensure(app, day, config);
      if (!dmf) return { changed: false, created: false };

      const { inserted, removedCount } = await dmf.reconcileRecurringHabits(
        settings.recurringTasks,
        day,
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
