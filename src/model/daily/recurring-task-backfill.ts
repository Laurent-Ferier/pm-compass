import { TFile } from "obsidian";
import { addDays, startOfIsoWeek, weekdayIndex } from "../dates";
import { reconcileRecurringHabits } from "../operations/habit-reconcile";
import { ensureFolderRecursive, parentDirOf } from "../operations/file-helpers";
import type { NoteFiles } from "../io/task-file";
import { canCreateDayNotes, readDailyNotesConfig } from "./daily-notes-plugin";
import type { PMCompassSettings } from "../settings";

export interface BackfillResult {
  filesChanged: number;
  filesCreated: number;
}

/** Gives today and the rest of the ISO week their scheduled habits, creating each daily
 *  note as needed. A day already past is left alone: a habit changed mid-week must not
 *  rewrite it. Each note it writes owes its store a re-read, which the note itself says. */
export async function backfillRecurringHabits(
  files: NoteFiles,
  settings: PMCompassSettings,
  today: Date = new Date(),
): Promise<BackfillResult> {
  const app = files.vault.app;
  const config = await readDailyNotesConfig(files.vault);
  const weekStart = startOfIsoWeek(today);

  const days: Date[] = [];
  for (let i = weekdayIndex(today); i < 7; i++) {
    days.push(addDays(weekStart, i));
  }

  // Ensure each day's parent directory exists once, up front — the ensure below also
  // checks this, but doing it here avoids concurrent calls below racing to create the same
  // folder (the date format can embed slashes, e.g. "YYYY/MM/DD", so multiple days can
  // share a parent directory even when config.folder is blank).
  // Skipped when no note can be created anyway, or the folders of a guessed format would
  // be the very files it refuses to make (see `DayNoteService.ensureFile`).
  if (await canCreateDayNotes(files.vault)) {
    const parentDirs = new Set<string>();
    for (const day of days) {
      const parentDir = parentDirOf(files.vault.dayNotes.pathOf(day, config));
      if (parentDir) parentDirs.add(parentDir);
    }
    for (const parentDir of parentDirs) {
      await ensureFolderRecursive(app, parentDir);
    }
  }

  // Each day is an independent file, so reconciling them can run concurrently instead of
  // blocking one after another (this runs on every dashboard render, see pm-compass-view.ts).
  const results = await Promise.all(
    days.map(async (day) => {
      const filePath = files.vault.dayNotes.pathOf(day, config);
      const existed = app.vault.getAbstractFileByPath(filePath) instanceof TFile;

      const notePath = await files.vault.dayNotes.ensureFile(day, config);
      if (!notePath) return { changed: false, created: false };

      const { changed } = await reconcileRecurringHabits(
        files.file(notePath),
        settings.recurringTasks,
        day,
        settings.recurringTasksHeading,
        settings.dailyHabitsTag,
      );
      return { changed, created: !existed };
    }),
  );

  return {
    filesChanged: results.filter((r) => r.changed).length,
    filesCreated: results.filter((r) => r.created).length,
  };
}
