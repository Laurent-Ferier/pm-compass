const CHECKBOX_RE = /^(\s*-\s+)\[([ xX])\]\s*(.+)$/;
const CREATED_DATE_RE = /➕\s*(\d{4}-\d{2}-\d{2})/;
const COMPLETED_DATE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/;
const DUE_DATE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/;
const SCHEDULED_DATE_RE = /⏳\s*(\d{4}-\d{2}-\d{2})/;
const START_DATE_RE = /🛫\s*(\d{4}-\d{2}-\d{2})/;
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
const TAG_RE = /#[^ -⁯⸀-⹿'!"#$%&()*+,.:;<=>?@^`{|}~[\]\\\s]+/g;

export class DayTask {
  readonly title: string;
  checked: boolean;
  readonly tags: string[];
  readonly createdAt: string | null;
  readonly completedAt: string | null;
  readonly dueDate: string | null;
  readonly scheduledDate: string | null;
  readonly startDate: string | null;
  readonly priority: string | null;
  readonly rawLine: string;
  readonly lineIndex: number;

  private constructor(fields: {
    title: string;
    checked: boolean;
    tags: string[];
    createdAt: string | null;
    completedAt: string | null;
    dueDate: string | null;
    scheduledDate: string | null;
    startDate: string | null;
    priority: string | null;
    rawLine: string;
    lineIndex: number;
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
  }

  static parse(line: string, lineIndex: number): DayTask | null {
    const m = CHECKBOX_RE.exec(line);
    if (!m) return null;
    const checkChar = m[2];
    const fullText = m[3];
    const checked = checkChar !== " ";
    const createdAt = CREATED_DATE_RE.exec(fullText)?.[1] ?? null;
    const completedAt = COMPLETED_DATE_RE.exec(fullText)?.[1] ?? null;
    const dueDate = DUE_DATE_RE.exec(fullText)?.[1] ?? null;
    const scheduledDate = SCHEDULED_DATE_RE.exec(fullText)?.[1] ?? null;
    const startDate = START_DATE_RE.exec(fullText)?.[1] ?? null;
    const priorityChar = PRIORITY_RE.exec(fullText)?.[0] ?? null;
    const priority = priorityChar ? (PRIORITY_MAP[priorityChar] ?? null) : null;
    const title = fullText.replace(TASK_METADATA_RE, "").replace(/\s+/g, " ").trim();
    const tags = [...title.matchAll(TAG_RE)].map((t) => t[0]);
    return new DayTask({ title, checked, tags, createdAt, completedAt, dueDate, scheduledDate, startDate, priority, rawLine: line, lineIndex });
  }

  /** Returns rawLine with [x] → [ ] and any ✅ date stripped. Used when toggling a task off. */
  static toUncheckedLine(rawLine: string): string {
    return rawLine
      .replace(/^(\s*-\s+)\[x\]/i, "$1[ ]")
      .replace(CLOSED_TS_RE, "");
  }

  /** Returns rawLine with [ ] → [x] and a ✅ date appended. Used when toggling a task on. */
  static toCheckedLine(rawLine: string, dateStr: string): string {
    return rawLine.replace(/^(\s*-\s+)\[ \]/, "$1[x]") + ` ✅ ${dateStr}`;
  }

  /** Returns `title` with the given habits tag stripped and whitespace collapsed.
   *  Uses a word-boundary lookahead so `#dailyish` is not stripped by tag `daily`. */
  displayTitle(habitsTag: string): string {
    const escaped = habitsTag.replace(/^#/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return this.title
      .replace(new RegExp(`\\s*#${escaped}(?![\\w-])`, "g"), "")
      .replace(/\s+/g, " ")
      .trim();
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
