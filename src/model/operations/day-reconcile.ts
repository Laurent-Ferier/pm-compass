import type { App } from "obsidian";
import { migrateInboxTargets } from "../daily/day-task-actions";
import { isTodayOrLaterInWeek, type RecurringTaskDefinition } from "../daily/recurring-task";
import type { DailyNotesConfig } from "../daily/week-summary";
import { DayMarkdownFile } from "../store/day-markdown-file";

/** What the pass is run under: the habit definitions and the headings they are written
 *  beneath, plus where the inbox lives and how a day note is named. Which settings these
 *  come from is the caller's — `TaskService` holds them. */
export interface DayReconcileOpts {
  recurringTasks: RecurringTaskDefinition[];
  recurringTasksHeading: string;
  dailyHabitsTag: string;
  dailyTasksHeading: string;
  inboxPath: string;
  dailyNotes: DailyNotesConfig;
}

/**
 * Puts one day note back in step with what the vault has moved on to: the habits its
 * definitions call for, and the inbox items aimed at a day that now has somewhere to put
 * them. A note that has just appeared, or been opened, is one that may have missed both.
 *
 * Names the paths it wrote, for the caller to invalidate — an operation says what it touched
 * rather than marking it itself, which would bury a cache write in a pass that reads like a
 * pure one. `touched` is filled as the writing happens rather than handed back at the end, so
 * a pass that throws halfway still names what it got through; the caller invalidates either
 * way. Left empty when there was nothing to put right.
 */
export async function reconcileDayNote(
  app: App,
  filePath: string,
  date: Date,
  opts: DayReconcileOpts,
  touched: string[] = [],
): Promise<string[]> {
  // Only today and the rest of the week get habits: reopening an older note must not
  // insert one that didn't exist, or was configured differently, at the time.
  if (isTodayOrLaterInWeek(date, new Date())) {
    await new DayMarkdownFile(app, filePath).reconcileRecurringHabits(
      opts.recurringTasks, date, opts.recurringTasksHeading, opts.dailyHabitsTag,
    );
    touched.push(filePath);
  }

  // The day has a note now, so the inbox items waiting on it can land in its checklist
  // rather than sit there until the dashboard is next opened.
  try {
    const moved = await migrateInboxTargets(app, opts.inboxPath, opts.dailyTasksHeading, opts.dailyNotes);
    if (moved > 0) touched.push(opts.inboxPath);
  } catch (e) {
    // The moves run one after another, so a throw leaves an unknown number of them done:
    // the inbox is suspect whether or not this got far enough to say so.
    touched.push(opts.inboxPath);
    throw e;
  }

  return touched;
}
