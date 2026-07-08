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
const PRIORITY_MAP: Record<string, string> = {
  "🔺": "critical",
  "⏫": "high",
  "🔼": "medium",
  "🔽": "low",
  "⏬": "lowest",
};

// All Obsidian Tasks plugin emoji markers (priority + date fields) and dataview inline fields.
const TASK_METADATA_RE = /(?:🔺|⏫|🔼|🔽|⏬|✅|❌|📅|⏳|🛫|➕|🔁)(?:\s+\d{4}-\d{2}-\d{2})?|\[[\w-]+::[^\]]*\]|\([\w-]+::[^)]*\)/g;

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

export class DayTask {
  readonly title: string;
  checked: boolean;
  readonly tags: string[];
  readonly createdAt: Date | null;
  readonly completedAt: Date | null;
  readonly dueDate: Date | null;
  readonly scheduledDate: Date | null;
  readonly startDate: Date | null;
  readonly priority: string | null;
  /** Mutable like `checked`: UI call sites that apply an in-place text edit without a
   *  full re-render (e.g. optimistic checkbox toggles) update this to keep it in sync. */
  rawLine: string;
  readonly lineIndex: number;
  /** Indented lines that immediately follow this task in the file (notes, sub-bullets). */
  readonly subLines: string[];

  private constructor(fields: {
    title: string;
    checked: boolean;
    tags: string[];
    createdAt: Date | null;
    completedAt: Date | null;
    dueDate: Date | null;
    scheduledDate: Date | null;
    startDate: Date | null;
    priority: string | null;
    rawLine: string;
    lineIndex: number;
    subLines: string[];
  }) {
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
    return new DayTask({
      title: this.title,
      checked: this.checked,
      tags: this.tags,
      createdAt: this.createdAt,
      completedAt: this.completedAt,
      dueDate: this.dueDate,
      scheduledDate: this.scheduledDate,
      startDate: this.startDate,
      priority: this.priority,
      rawLine: this.rawLine,
      lineIndex: this.lineIndex,
      subLines,
    });
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
