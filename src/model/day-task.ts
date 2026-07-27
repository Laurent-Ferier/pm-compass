import { BaseTask } from "./base-task";
import { Priority } from "./task-vocabulary";

const CHECKBOX_RE = /^(\s*-\s+)\[([ xX])\]\s*(.+)$/;
const CREATED_DATE_RE = /➕\s*(\d{4}-\d{2}-\d{2})/;
const COMPLETED_DATE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/;
const DUE_DATE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/;
const SCHEDULED_DATE_RE = /⏳\s*(\d{4}-\d{2}-\d{2})/;
const START_DATE_RE = /🛫\s*(\d{4}-\d{2}-\d{2})/;

export function parseDate(str: string): Date {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Normalizes `settings.dailyHabitsTag` to a bare tag name (no leading `#`, "daily"
 *  default when unset) — the form `DayTask.tags`/`displayTitle`/`habitMatchTitle` expect. */
export function resolveHabitsTag(dailyHabitsTag: string | undefined): string {
  return (dailyHabitsTag || "daily").replace(/^#/, "");
}
const PRIORITY_RE = /[🔺⏫🔼🔽⏬]/u;
const PRIORITY_MAP: Record<string, Priority> = {
  "🔺": Priority.Critical,
  "⏫": Priority.High,
  "🔼": Priority.Medium,
  "🔽": Priority.Low,
  "⏬": Priority.Lowest,
};

/** `PRIORITY_MAP` reversed — the marker to write when a priority is set on a line.
 *  Derived rather than spelled out a second time, so the two can't drift apart. */
export const PRIORITY_EMOJI: Partial<Record<Priority, string>> = Object.fromEntries(
  Object.entries(PRIORITY_MAP).map(([emoji, level]) => [level, emoji]),
);

/** Higher = more urgent. Its own scale rather than task-vocabulary's `PRIORITY_SCORE`,
 *  which knows nothing of `lowest` (a checklist-only level with no Task counterpart).
 *  Unset sorts below every set priority. */
const PRIORITY_RANK: Record<Priority, number> = {
  [Priority.Critical]: 5,
  [Priority.High]: 4,
  [Priority.Medium]: 3,
  [Priority.Low]: 2,
  [Priority.Lowest]: 1,
  [Priority.None]: 0,
};

/**
 * Whether an inbox item has waited long enough to be flagged as stale — the rule behind
 * both the row's warning badge and the Inbox tab's. An item aimed at a day (⏳) is exempt:
 * it isn't untriaged work piling up, it is planned.
 */
export function isStaleInboxItem(
  item: Pick<DayTask, "createdAt" | "scheduledDate">,
  staleAfterDays: number,
): boolean {
  if (staleAfterDays <= 0 || item.scheduledDate || !item.createdAt) return false;
  return Math.floor((Date.now() - item.createdAt.getTime()) / 86_400_000) >= staleAfterDays;
}

export function priorityRank(priority: Priority | null): number {
  return priority ? (PRIORITY_RANK[priority] ?? 0) : 0;
}

// All Obsidian Tasks plugin emoji markers (priority + date fields) and dataview inline fields.
// `🔁` is spelled out separately because its payload is a rule in words ("every 2 weeks"),
// not a date: without swallowing that run the rule would be left behind as title text and
// the marker detached from it. It stops at the next marker, a `#tag` or a dataview field —
// none of which can appear inside a recurrence rule.
const TASK_METADATA_RE = /🔁(?:\s+[^\s#🔺⏫🔼🔽⏬✅❌📅⏳🛫➕🔁[(]+)*|(?:🔺|⏫|🔼|🔽|⏬|✅|❌|📅|⏳|🛫|➕)(?:\s+\d{4}-\d{2}-\d{2})?|\[[\w-]+::[^\]]*\]|\([\w-]+::[^)]*\)/gu;

// Strips a ✅ completion timestamp from a raw line when unchecking an item.
// Includes leading whitespace so the result doesn't have a trailing space.
const CLOSED_TS_RE = /\s*✅\s*\d{4}-\d{2}-\d{2}/g;

// Obsidian tag syntax: # followed by non-whitespace, non-punctuation characters.
// The excluded ranges are Unicode direction/format blocks (U+2000–U+206F, U+2E00–U+2E7F)
// and ASCII punctuation — NOT regular letters/digits, which are allowed in tag names.
const TAG_RE = /#[^\u2000-\u206f\u2e00-\u2e7f'!"#$%&()*+,.:;<=>?@^`{|}~[\]\\\s]+/g;

// Strips a single `#tag` occurrence from `text`. Uses a word-boundary lookahead so
// `#dailyish` is not stripped by tag `daily`.
function stripTag(text: string, tag: string): string {
  const escaped = tag.replace(/^#/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\s*#${escaped}(?![\\w-])`, "g"), "");
}

export class DayTask extends BaseTask {
  readonly title: string;
  checked: boolean;
  readonly tags: string[];
  readonly createdAt: Date | null;
  readonly completedAt: Date | null;
  readonly dueDate: Date | null;
  readonly scheduledDate: Date | null;
  readonly startDate: Date | null;
  readonly priority: Priority | null;
  /** Mutable like `checked`: UI call sites that apply an in-place text edit without a
   *  full re-render (e.g. optimistic checkbox toggles) update this to keep it in sync. */
  rawLine: string;
  readonly lineIndex: number;
  /** Indented lines that immediately follow this task in the file (notes, sub-bullets). */
  readonly subLines: string[];
  /** The note it was read from, and the day that note is for — see `withSource`. */
  readonly filePath: string | null;
  readonly noteDate: string | null;

  private constructor(fields: {
    title: string;
    checked: boolean;
    tags: string[];
    createdAt: Date | null;
    completedAt: Date | null;
    dueDate: Date | null;
    scheduledDate: Date | null;
    startDate: Date | null;
    priority: Priority | null;
    rawLine: string;
    lineIndex: number;
    subLines: string[];
    filePath?: string | null;
    noteDate?: string | null;
  }) {
    super();
    this.title = fields.title;
    this.checked = fields.checked;
    this.tags = fields.tags;
    this.createdAt = fields.createdAt;
    this.completedAt = fields.completedAt;
    this.dueDate = fields.dueDate;
    this.scheduledDate = fields.scheduledDate;
    this.startDate = fields.startDate;
    this.priority = fields.priority;
    this.rawLine = fields.rawLine;
    this.lineIndex = fields.lineIndex;
    this.subLines = fields.subLines;
    this.filePath = fields.filePath ?? null;
    this.noteDate = fields.noteDate ?? null;
  }

  /** Everything but the identity of the line, for the copies below. */
  private fields() {
    return {
      title: this.title, checked: this.checked, tags: this.tags,
      createdAt: this.createdAt, completedAt: this.completedAt, dueDate: this.dueDate,
      scheduledDate: this.scheduledDate, startDate: this.startDate, priority: this.priority,
      rawLine: this.rawLine, lineIndex: this.lineIndex, subLines: this.subLines,
      filePath: this.filePath, noteDate: this.noteDate,
    };
  }

  /**
   * A copy that knows where it came from: the note holding the line, and the day that note
   * is for. A line says nothing about either, and a row shown from one needs both — which
   * file an action writes to, and where it sorts. The Inbox's lines get a path and no day.
   */
  withSource(filePath: string | null, noteDate?: string | null): DayTask {
    return new DayTask({ ...this.fields(), filePath, noteDate: noteDate ?? null });
  }

  /** The day it falls under: the note's, or — an Inbox line — the day it is waiting for,
   *  its ⏳ target, else its 📅 deadline. */
  get plannedDate(): string | undefined {
    if (this.noteDate) return this.noteDate;
    const date = this.scheduledDate ?? this.dueDate;
    return date ? formatDate(date) : undefined;
  }

  static parse(line: string, lineIndex: number): DayTask | null {
    const m = CHECKBOX_RE.exec(line);
    if (!m) return null;
    const checkChar = m[2];
    const fullText = m[3];
    const checked = checkChar !== " ";
    const createdAtStr = CREATED_DATE_RE.exec(fullText)?.[1] ?? null;
    const completedAtStr = COMPLETED_DATE_RE.exec(fullText)?.[1] ?? null;
    const dueDateStr = DUE_DATE_RE.exec(fullText)?.[1] ?? null;
    const scheduledDateStr = SCHEDULED_DATE_RE.exec(fullText)?.[1] ?? null;
    const startDateStr = START_DATE_RE.exec(fullText)?.[1] ?? null;
    const createdAt = createdAtStr ? parseDate(createdAtStr) : null;
    const completedAt = completedAtStr ? parseDate(completedAtStr) : null;
    const dueDate = dueDateStr ? parseDate(dueDateStr) : null;
    const scheduledDate = scheduledDateStr ? parseDate(scheduledDateStr) : null;
    const startDate = startDateStr ? parseDate(startDateStr) : null;
    const priorityChar = PRIORITY_RE.exec(fullText)?.[0] ?? null;
    const priority = priorityChar ? PRIORITY_MAP[priorityChar] : null;
    const title = fullText.replace(TASK_METADATA_RE, "").replace(/\s+/g, " ").trim();
    const tags = [...title.matchAll(TAG_RE)].map((t) => t[0]);
    return new DayTask({ title, checked, tags, createdAt, completedAt, dueDate, scheduledDate, startDate, priority, rawLine: line, lineIndex, subLines: [] });
  }

  /** Creates a brand-new unchecked task with the given title and creation date. */
  static create(title: string, createdAt: Date): DayTask {
    return new DayTask({
      title,
      checked: false,
      tags: [...title.matchAll(TAG_RE)].map((m) => m[0]),
      createdAt,
      completedAt: null,
      dueDate: null,
      scheduledDate: null,
      startDate: null,
      priority: null,
      rawLine: `${DayTask.checkboxLine(title)} ➕ ${formatDate(createdAt)}`,
      lineIndex: 0,
      subLines: [],
    });
  }

  /** Renders an unchecked checkbox line for `title`. Shared so every code path that
   *  builds a fresh task line (creation, recurring habits) stays in sync. */
  static checkboxLine(title: string): string {
    return `- [ ] ${title}`;
  }

  /** Returns a copy of this task with the given sub-lines attached. */
  withSubLines(subLines: string[]): DayTask {
    return new DayTask({ ...this.fields(), subLines });
  }

  /** Returns rawLine with [x] → [ ] and any ✅ date stripped. Used when toggling a task off. */
  static toUncheckedLine(rawLine: string): string {
    return rawLine
      .replace(/^(\s*-\s+)\[x\]/i, "$1[ ]")
      .replace(CLOSED_TS_RE, "");
  }

  /** Returns rawLine with [ ] → [x] and a ✅ date appended. Used when toggling a task on. */
  static toCheckedLine(rawLine: string, date: Date): string {
    return rawLine.replace(/^(\s*-\s+)\[ \]/, "$1[x]") + ` ✅ ${formatDate(date)}`;
  }

  /**
   * Returns `rawLine` with its title text replaced by `newTitle`, leaving the checkbox
   * marker and all metadata (priority, dates, recurrence marker, dataview fields) untouched.
   * Collects every metadata match anywhere in the line (mirroring how `title` is computed
   * in `parse`, by stripping every match rather than just a trailing block) and reappends
   * them after the new title, so metadata embedded mid-title isn't misread as part of the
   * editable text.
   */
  static withUpdatedTitle(rawLine: string, newTitle: string): string {
    const m = CHECKBOX_RE.exec(rawLine);
    if (!m) return rawLine;
    const [, prefix, checkChar, fullText] = m;
    const metadataSuffix = (fullText.match(TASK_METADATA_RE) ?? []).join(" ").trim();
    const rebuilt = metadataSuffix ? `${newTitle} ${metadataSuffix}` : newTitle;
    return `${prefix}[${checkChar}] ${rebuilt}`;
  }

  /**
   * Returns `rawLine` with its priority marker replaced by `priority`'s (`Priority.None`
   * removes it), leaving the checkbox marker, title and every other metadata
   * token untouched. Like `withUpdatedTitle`, metadata is collected from anywhere in
   * the line and reappended after the title, so the marker lands in the position the
   * Obsidian Tasks plugin expects rather than wherever the old one happened to sit.
   */
  static withUpdatedPriority(rawLine: string, priority: Priority): string {
    const m = CHECKBOX_RE.exec(rawLine);
    if (!m) return rawLine;
    const [, prefix, checkChar, fullText] = m;
    const metadata = (fullText.match(TASK_METADATA_RE) ?? []).filter((token) => !PRIORITY_RE.test(token));
    const title = fullText.replace(TASK_METADATA_RE, "").replace(/\s+/g, " ").trim();
    const marker = PRIORITY_EMOJI[priority] ?? "";
    const parts = [title, marker, ...metadata].filter((p) => p !== "");
    return `${prefix}[${checkChar}] ${parts.join(" ")}`;
  }

  /**
   * Returns `rawLine` with its ⏳ target date set to `date`, or removed when `date` is
   * null. Metadata is collected and reappended as in `withUpdatedPriority`; the ⏳ token
   * lands last, after the markers the Obsidian Tasks plugin expects to come first. A
   * clear with nothing to clear returns the line untouched rather than putting it through
   * that rebuild, which would also normalise metadata order and spacing.
   */
  static withUpdatedScheduledDate(rawLine: string, date: Date | null): string {
    if (!date && !SCHEDULED_DATE_RE.test(rawLine)) return rawLine;
    const m = CHECKBOX_RE.exec(rawLine);
    if (!m) return rawLine;
    const [, prefix, checkChar, fullText] = m;
    const metadata = (fullText.match(TASK_METADATA_RE) ?? []).filter((token) => !token.startsWith("⏳"));
    const title = fullText.replace(TASK_METADATA_RE, "").replace(/\s+/g, " ").trim();
    const parts = [title, ...metadata, date ? `⏳ ${formatDate(date)}` : ""].filter((p) => p !== "");
    return `${prefix}[${checkChar}] ${parts.join(" ")}`;
  }

  /** Returns `title` with the given habits tag stripped and whitespace collapsed.
   *  Uses a word-boundary lookahead so `#dailyish` is not stripped by tag `daily`. */
  displayTitle(habitsTag: string): string {
    return stripTag(this.title, habitsTag).replace(TAG_RE, "").replace(/\s+/g, " ").trim();
  }

  /** Returns `title` with only `habitsTag` stripped — unlike displayTitle, any other tag
   *  present in the title is left untouched. Used to match a rendered habit line back to
   *  its definition, since a definition's own title may legitimately contain a `#tag`. */
  habitMatchTitle(habitsTag: string): string {
    return stripTag(this.title, habitsTag).replace(/\s+/g, " ").trim();
  }

  /**
   * Returns all Obsidian tag matches (with positions) found in `text`.
   * Used by renderTextWithInlineTags to locate tags for link rendering.
   * Exported as a static method so TAG_RE stays internal to this module.
   */
  static matchAllTags(text: string): RegExpMatchArray[] {
    return [...text.matchAll(TAG_RE)];
  }
}
