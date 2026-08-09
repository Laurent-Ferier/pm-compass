import { App, CachedMetadata, normalizePath } from "obsidian";
import { resolveFile } from "../operations/file-helpers";
import {
  Frontmatter, asFrontmatterRecord, splitFrontmatterBody, stringArray, touch,
} from "./frontmatter";

/** Where a parent records its children: `subtaskIds` / `## Subtasks` for a task,
 *  `taskIds` / `## Tasks` for a project, both as `- [ ] [[basename|title]]`. */
export interface ChildLinkSection {
  /** Frontmatter field holding the child ID list. */
  idField: Frontmatter.SubtaskIds | Frontmatter.TaskIds;
  /** Body heading introducing the checklist, including the `##` prefix. */
  heading: string;
}

export const SUBTASK_SECTION: ChildLinkSection = {
  idField: Frontmatter.SubtaskIds, heading: "## Subtasks",
};
export const PROJECT_TASK_SECTION: ChildLinkSection = {
  idField: Frontmatter.TaskIds, heading: "## Tasks",
};

/** One child as its parent should list it. */
export interface ChildEntry {
  id: string;
  title: string;
  basename: string;
  checked: boolean;
}

function checklistItem(basename: string, title: string, checked: boolean): string {
  return `- [${checked ? "x" : " "}] [[${basename}|${title}]]`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** This child's checklist item, ticked or not, alias or not so a hand-edited `[[slug]]`
 *  still matches. Line-anchored like `entryRegex`; the newline is part of the match. */
function linkRegex(basename: string): RegExp {
  return new RegExp(`(?:^|\\n)- \\[[ xX]\\] \\[\\[${escapeRe(basename)}(?:\\|[^\\]]*)?\\]\\]`, "g");
}

/** Any entry in a section: box, basename, optional alias. Line-anchored, so a nested
 *  checklist isn't read as a child. Built fresh per call — a `/g` regex keeps state. */
function entryRegex(): RegExp {
  return /^- \[([ xX])\] \[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/gm;
}

/** The span of `body` from the section's heading to the next `## ` or EOF, null when
 *  absent. Link edits stay inside it, so a quoted checklist line can't be mistaken
 *  for a real entry. */
function sectionRange(body: string, heading: string): { start: number; end: number } | null {
  // Anchored to a whole line, so a quoted `## Tasks` or a `### Tasks` doesn't match.
  const anchored = new RegExp(`(?:^|\\n)${escapeRe(heading)}[ \\t]*(?:\\n|$)`);
  const match = anchored.exec(body);
  if (!match) return null;
  const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
  const after = body.slice(start + heading.length);
  const next = after.search(/\n## /);
  return { start, end: next === -1 ? body.length : start + heading.length + next };
}

/**
 * One entry of a listing as the note holds it: which child it names, and how its box
 * stands. The title on the line is the child's own and is not read back.
 *
 * Every writer below hands back the listing it left, or null for a pass that wrote
 * nothing — which is how the note holding a reading of that listing learns what it just
 * wrote, and so doesn't take its own write back as an edit when Obsidian reparses it.
 */
export interface ChildBox {
  basename: string;
  checked: boolean;
}

/** Every child listed under the section, with the state of its box. */
export function readChildLinkBoxes(body: string, section: ChildLinkSection): ChildBox[] {
  const range = sectionRange(body, section.heading);
  if (!range) return [];
  const entries = body.slice(range.start, range.end).matchAll(entryRegex());
  return [...entries].map((m) => ({ basename: m[2], checked: m[1] !== " " }));
}

/** Where the link sits on `- [ ] [[child]]`, which is the only shape `entryRegex` reads. */
const LINK_COLUMN = "- [ ] ".length;

/**
 * The same listing as `readChildLinkBoxes`, off Obsidian's own reading of the file rather
 * than off its text: the headings say where the section is, the list items carry the boxes,
 * and the links say what each one names. Nothing is read from disk, so a note's listing
 * costs what its frontmatter costs — which is what lets it be held alongside it.
 *
 * Deliberately as narrow as the regex it stands in for: a level-2 heading, an unindented
 * item, a `[ ]`/`[x]` box, and the link immediately after it. Anything else in the section
 * is prose, and prose lists nobody.
 */
export function listingFromCache(cache: CachedMetadata | null, section: ChildLinkSection): ChildBox[] {
  const wanted = section.heading.replace(/^#+[ \t]*/, "");
  const headings = cache?.headings ?? [];
  const heading = headings.find((h) => h.level === 2 && h.heading === wanted);
  if (!heading) return [];

  // The section runs to the next `## `, as `sectionRange` has it: a deeper heading is
  // still inside it.
  const from = heading.position.start.line;
  const to = headings
    .filter((h) => h.level === 2 && h.position.start.line > from)
    .reduce((first, h) => Math.min(first, h.position.start.line), Number.POSITIVE_INFINITY);

  const boxes: ChildBox[] = [];
  for (const item of cache?.listItems ?? []) {
    const line = item.position.start.line;
    if (line <= from || line >= to) continue;
    if (item.position.start.col !== 0 || item.task === undefined) continue;
    // Obsidian calls any character a box; only these three are an entry to this plugin.
    if (item.task !== " " && item.task !== "x" && item.task !== "X") continue;
    const link = cache?.links?.find(
      (l) => l.position.start.line === line && l.position.start.col === LINK_COLUMN,
    );
    // `link` is the target as written, alias stripped — which is the basename the entry names.
    if (link) boxes.push({ basename: link.link, checked: item.task !== " " });
  }
  return boxes;
}

/** `body` with `items` added under the section, starting one when it isn't there. */
function appendEntries(body: string, section: ChildLinkSection, items: string[]): string {
  if (items.length === 0) return body;
  const block = items.join("\n");
  const range = sectionRange(body, section.heading);

  if (!range) {
    const trimmed = body.trimEnd();
    return (trimmed ? trimmed + "\n\n" : "") + section.heading + "\n" + block + "\n";
  }

  const before = body.slice(0, range.start);
  const appended = body.slice(range.start, range.end).trimEnd() + "\n" + block + "\n";
  const after = body.slice(range.end);
  return after ? before + appended + "\n" + after.trimStart() : before + appended;
}

/**
 * Rewrites the section's entries through `change` in one pass, leaving alone any it
 * returns nothing for. Never touches the frontmatter. Writing only when an entry moved
 * is what stops the box/status sync trading events forever.
 */
async function rewriteChildLinks(
  app: App,
  parentFilePath: string,
  section: ChildLinkSection,
  change: (basename: string) => { title?: string; checked?: boolean } | undefined,
): Promise<ChildBox[] | null> {
  const file = resolveFile(app, parentFilePath);
  if (!file) return null;

  const { frontmatterBlock, body } = splitFrontmatterBody(await app.vault.read(file));
  if (!frontmatterBlock) return null;

  const range = sectionRange(body, section.heading);
  if (!range) return null;

  const inSection = body.slice(range.start, range.end);
  const rewritten = inSection.replace(entryRegex(), (entry, box: string, basename: string, alias?: string) => {
    const changes = change(basename);
    if (!changes) return entry;
    const checked = changes.checked ?? box !== " ";
    const title = changes.title ?? alias;
    // A hand-edited `[[slug]]` carries no title to keep, so it stays bare.
    const link = title === undefined ? `[[${basename}]]` : `[[${basename}|${title}]]`;
    return `- [${checked ? "x" : " "}] ${link}`;
  });
  if (rewritten === inSection) return null;

  const newBody = body.slice(0, range.start) + rewritten + body.slice(range.end);
  await app.vault.modify(file, frontmatterBlock + newBody);
  return readChildLinkBoxes(newBody, section);
}

/** Registers a child in a parent: its ID in the section's frontmatter list, a checklist
 *  item under the heading. Idempotent, so a partly applied move is safe to retry. */
export async function addChildLink(
  app: App,
  parentFilePath: string,
  section: ChildLinkSection,
  childId: string,
  childTitle: string,
  childBasename: string,
  checked = false,
): Promise<ChildBox[] | null> {
  const file = resolveFile(app, parentFilePath);
  if (!file) return null;

  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    const current: string[] = stringArray(fm[section.idField]);
    fm[section.idField] = current.includes(childId) ? current : [...current, childId];
    touch(fm);
  });

  const raw = await app.vault.read(file);
  const { frontmatterBlock, body } = splitFrontmatterBody(raw);
  if (!frontmatterBlock) return null;

  const newItem = checklistItem(childBasename, childTitle, checked);
  const range = sectionRange(body, section.heading);

  // An entry under a stale title is refreshed in place rather than duplicated.
  if (range) {
    const before = body.slice(0, range.start);
    const inSection = body.slice(range.start, range.end);
    const after = body.slice(range.end);
    if (linkRegex(childBasename).test(inSection)) {
      const replaced = inSection.replace(linkRegex(childBasename), "\n" + newItem);
      if (replaced === inSection) return null;
      const newBody = before + replaced + after;
      await app.vault.modify(file, frontmatterBlock + newBody);
      return readChildLinkBoxes(newBody, section);
    }
  }

  const appended = appendEntries(body, section, [newItem]);
  await app.vault.modify(file, frontmatterBlock + appended);
  return readChildLinkBoxes(appended, section);
}

/** Rewrites one child's existing entry — title, box, or both. Adds nothing when the
 *  entry is absent, so a status pushed mid-move leaves both parents alone. */
export function updateChildLink(
  app: App,
  parentFilePath: string,
  section: ChildLinkSection,
  childBasename: string,
  changes: { title?: string; checked?: boolean },
): Promise<ChildBox[] | null> {
  return rewriteChildLinks(app, parentFilePath, section, (b) => (b === childBasename ? changes : undefined));
}

/** Set several children's boxes in one write, leaving the unnamed ones alone. */
export function setChildLinkBoxes(
  app: App,
  parentFilePath: string,
  section: ChildLinkSection,
  checked: Map<string, boolean>,
): Promise<ChildBox[] | null> {
  return rewriteChildLinks(app, parentFilePath, section, (b) =>
    checked.has(b) ? { checked: checked.get(b) } : undefined);
}

/**
 * Brings a parent's listing into line with `children` — entries relabelled and reticked,
 * missing ones appended, the ID list refreshed — and hands back the listing it left, or
 * null for a pass that wrote nothing. An unclaimed entry is dropped only where it resolves
 * to a task note in `childFolder`; anything else is a link the user wrote, left for
 * `ProjectTaskIO.delete` to clean up.
 */
export async function syncChildLinks(
  app: App,
  parentFilePath: string,
  section: ChildLinkSection,
  children: ChildEntry[],
  childFolder: string,
): Promise<ChildBox[] | null> {
  const file = resolveFile(app, parentFilePath);
  if (!file) return null;

  const { frontmatterBlock, body } = splitFrontmatterBody(await app.vault.read(file));
  if (!frontmatterBlock) return null;

  const wanted = new Map(children.map((c) => [c.basename, c]));

  /** A stray entry the plugin owns: a task note of this parent's folder, gone elsewhere. */
  const hasDeparted = (basename: string): boolean => {
    const child = resolveFile(app, normalizePath(`${childFolder}/${basename}.md`));
    return !!child && app.metadataCache.getFileCache(child)?.frontmatter?.[Frontmatter.IsTask] === true;
  };

  // The ID list keeps its order, so a repair can't reshuffle a field obsidian-pm
  // writes too and hand Sync a conflict.
  const fm = asFrontmatterRecord(app.metadataCache.getFileCache(file)?.frontmatter);
  const ids = stringArray(fm?.[section.idField]);
  const wantedIds = new Set(children.map((c) => c.id));
  const kept = ids.filter((id) => wantedIds.has(id));
  const newIds = [...kept, ...children.map((c) => c.id).filter((id) => !kept.includes(id))];

  // `processFrontMatter` rewrites the file whatever the callback does, so calling it
  // unguarded would restamp every note in the vault on every pass.
  const idsChanged = newIds.length !== ids.length || newIds.some((id, i) => id !== ids[i]);
  if (idsChanged) {
    await app.fileManager.processFrontMatter(file, (m: Record<string, unknown>) => {
      m[section.idField] = newIds;
      touch(m);
    });
  }

  const newBody = rewriteSection(body, section, wanted, hasDeparted);
  if (newBody === body) return idsChanged ? readChildLinkBoxes(body, section) : null;

  // `process` rather than read-then-modify: the frontmatter write above already moved
  // the file underneath us.
  await app.vault.process(file, (current) => {
    const split = splitFrontmatterBody(current);
    return split.frontmatterBlock ? split.frontmatterBlock + newBody : current;
  });
  return readChildLinkBoxes(newBody, section);
}

/** The body with the section's entries brought into line with `wanted`. Line by line,
 *  so dropping an entry doesn't leave the blank line a regex replace would. */
function rewriteSection(
  body: string,
  section: ChildLinkSection,
  wanted: Map<string, ChildEntry>,
  hasDeparted: (basename: string) => boolean,
): string {
  const range = sectionRange(body, section.heading);
  const listed = new Set<string>();

  let withinSection = body;
  if (range) {
    const lines = body.slice(range.start, range.end).split("\n");
    const rewritten: string[] = [];
    for (const line of lines) {
      const entry = entryRegex().exec(line);
      if (!entry) { rewritten.push(line); continue; }
      const basename = entry[2];
      const want = wanted.get(basename);
      if (want) {
        listed.add(basename);
        rewritten.push(checklistItem(basename, want.title, want.checked));
      } else if (!hasDeparted(basename)) {
        rewritten.push(line);
      }
    }
    // Collapsed inside the section only; spacing elsewhere in the note is the user's.
    const inSection = rewritten.join("\n").replace(/\n{3,}/g, "\n\n");
    withinSection = body.slice(0, range.start) + inSection + body.slice(range.end);
  }

  const missing = [...wanted.values()]
    .filter((c) => !listed.has(c.basename))
    .map((c) => checklistItem(c.basename, c.title, c.checked));
  return appendEntries(withinSection, section, missing);
}

/** Unregisters a child: drops its ID and its checklist item, and the heading if that
 *  empties the section. Matches on `childBasename`, so it must run before a rename. */
export async function removeChildLink(
  app: App,
  parentFilePath: string,
  section: ChildLinkSection,
  childId: string,
  childBasename: string,
): Promise<ChildBox[] | null> {
  const file = resolveFile(app, parentFilePath);
  if (!file) return null;

  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    const current: string[] = stringArray(fm[section.idField]);
    fm[section.idField] = current.filter((id) => id !== childId);
    touch(fm);
  });

  return removeChildEntry(app, parentFilePath, section, childBasename);
}

/**
 * `removeChildLink` without the frontmatter half, for an unlinking with no id to prune —
 * a task deleted outside the plugin, whose stale id `syncChildLinks` drops later. Uses
 * `process` because the delete event can have this editing the same note as the deletion.
 */
export async function removeChildEntry(
  app: App,
  parentFilePath: string,
  section: ChildLinkSection,
  childBasename: string,
): Promise<ChildBox[] | null> {
  const file = resolveFile(app, parentFilePath);
  if (!file) return null;

  let left: ChildBox[] | null = null;
  await app.vault.process(file, (current: string) => {
    const { frontmatterBlock, body } = splitFrontmatterBody(current);
    if (!frontmatterBlock) return current;

    const range = sectionRange(body, section.heading);
    if (!range) return current;

    const inSection = body.slice(range.start, range.end);
    const stripped = inSection.replace(linkRegex(childBasename), "");
    if (stripped === inSection) return current;

    let newBody = body.slice(0, range.start) + stripped + body.slice(range.end);
    const emptyHeading = new RegExp(`\\n?${escapeRe(section.heading)}\\n(?=\\n|$)`);
    newBody = newBody.replace(emptyHeading, "").replace(/\n{3,}/g, "\n\n");
    left = readChildLinkBoxes(newBody, section);
    return frontmatterBlock + newBody;
  });
  return left;
}
