import { App, normalizePath } from "obsidian";
import {
  asFrontmatterRecord, resolveFile, splitFrontmatterBody, stringArray, touch,
} from "../operations/file-helpers";
import { Frontmatter } from "./frontmatter";

/**
 * Identifies where a parent file records its children. Tasks track subtasks in
 * `subtaskIds` / `## Subtasks`; projects track root tasks in `taskIds` / `## Tasks`.
 * Both use the same `- [ ] [[basename|title]]` checklist format, the box mirroring
 * whether the child is done.
 */
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

/**
 * Matches this child's checklist item, ticked or not, with or without the `|title`
 * alias the plugin always writes — a hand-edited `[[slug]]` must still be found.
 *
 * Line-anchored like `entryRegex`, and for the same reason: an indented line nested
 * under an entry is the user's own breakdown, not this child's entry. The preceding
 * newline is part of the match so removing an entry takes its whole line.
 */
function linkRegex(basename: string): RegExp {
  return new RegExp(`(?:^|\\n)- \\[[ xX]\\] \\[\\[${escapeRe(basename)}(?:\\|[^\\]]*)?\\]\\]`, "g");
}

/**
 * Any entry in a section: box, basename, optional alias. Line-anchored, so an
 * indented checklist nested under an entry — the user's own breakdown of it — is
 * neither read as a child nor rewritten as one.
 *
 * Built fresh per call rather than shared: a `/g` regex carries `lastIndex`
 * between uses, and one stray `exec`/`test` on a shared instance would leave the
 * next caller starting mid-section.
 */
function entryRegex(): RegExp {
  return /^- \[([ xX])\] \[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/gm;
}

/**
 * The span of `body` belonging to the section: from its heading to the next
 * `## ` heading or end of file. Null when the heading isn't present.
 *
 * Link edits are confined to this span so a checklist line quoted in the task's
 * own description can't be mistaken for the real entry.
 */
function sectionRange(body: string, heading: string): { start: number; end: number } | null {
  // Anchor the heading to a whole line, so a `## Tasks` quoted inside the task's
  // own description — or a `### Tasks` sub-heading that merely contains it — is
  // not mistaken for the real section.
  const anchored = new RegExp(`(?:^|\\n)${escapeRe(heading)}[ \\t]*(?:\\n|$)`);
  const match = anchored.exec(body);
  if (!match) return null;
  const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
  const after = body.slice(start + heading.length);
  const next = after.search(/\n## /);
  return { start, end: next === -1 ? body.length : start + heading.length + next };
}

/** Every child listed under the section, with the state of its box. */
export function readChildLinkBoxes(
  body: string, section: ChildLinkSection,
): { basename: string; checked: boolean }[] {
  const range = sectionRange(body, section.heading);
  if (!range) return [];
  const entries = body.slice(range.start, range.end).matchAll(entryRegex());
  return [...entries].map((m) => ({ basename: m[2], checked: m[1] !== " " }));
}

/**
 * `body` with `items` added under the section, starting one when it isn't there.
 * Shared by the two callers that grow a listing so the heading and its blank-line
 * joining are decided in one place.
 */
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
 * Rewrite the section's entries through `change` in one pass, leaving alone any it
 * returns nothing for. Never touches the frontmatter: an entry's title and box are the
 * child's own facts, not the parent's.
 *
 * Writing only when an entry moved is not an optimisation — it is what stops the two
 * directions of the box/status sync trading events forever.
 */
async function rewriteChildLinks(
  app: App,
  parentFilePath: string,
  section: ChildLinkSection,
  change: (basename: string) => { title?: string; checked?: boolean } | undefined,
): Promise<void> {
  const file = resolveFile(app, parentFilePath);
  if (!file) return;

  const { frontmatterBlock, body } = splitFrontmatterBody(await app.vault.read(file));
  if (!frontmatterBlock) return;

  const range = sectionRange(body, section.heading);
  if (!range) return;

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
  if (rewritten === inSection) return;

  await app.vault.modify(file, frontmatterBlock + body.slice(0, range.start) + rewritten + body.slice(range.end));
}

/**
 * Register a child inside a parent file: appends its ID to the section's
 * frontmatter list and a checklist item under the section heading, creating the
 * heading when absent. `checked` ticks the box, for a child already done.
 *
 * Idempotent — re-running never double-links, which is what makes a partially
 * applied move safe to retry.
 */
export async function addChildLink(
  app: App,
  parentFilePath: string,
  section: ChildLinkSection,
  childId: string,
  childTitle: string,
  childBasename: string,
  checked = false,
): Promise<void> {
  const file = resolveFile(app, parentFilePath);
  if (!file) return;

  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    const current: string[] = stringArray(fm[section.idField]);
    fm[section.idField] = current.includes(childId) ? current : [...current, childId];
    touch(fm);
  });

  const raw = await app.vault.read(file);
  const { frontmatterBlock, body } = splitFrontmatterBody(raw);
  if (!frontmatterBlock) return;

  const newItem = checklistItem(childBasename, childTitle, checked);
  const range = sectionRange(body, section.heading);

  // A link to this child may already sit in the section under a stale title;
  // refresh it in place rather than appending a duplicate.
  if (range) {
    const before = body.slice(0, range.start);
    const inSection = body.slice(range.start, range.end);
    const after = body.slice(range.end);
    if (linkRegex(childBasename).test(inSection)) {
      const replaced = inSection.replace(linkRegex(childBasename), "\n" + newItem);
      if (replaced !== inSection) await app.vault.modify(file, frontmatterBlock + before + replaced + after);
      return;
    }
  }

  await app.vault.modify(file, frontmatterBlock + appendEntries(body, section, [newItem]));
}

/**
 * Rewrite one child's existing entry: its title, its box, or both — whichever
 * `changes` names. Adds nothing when the entry isn't there, unlike `addChildLink`.
 *
 * That it never adds is what keeps a status pushed mid-move from writing a line
 * into a note that no longer lists the task — the entry has already been taken out
 * of the old parent and not yet put into the new one, and both are left alone.
 */
export function updateChildLink(
  app: App,
  parentFilePath: string,
  section: ChildLinkSection,
  childBasename: string,
  changes: { title?: string; checked?: boolean },
): Promise<void> {
  return rewriteChildLinks(app, parentFilePath, section, (b) => (b === childBasename ? changes : undefined));
}

/** Set several children's boxes in one write, leaving the unnamed ones alone. */
export function setChildLinkBoxes(
  app: App,
  parentFilePath: string,
  section: ChildLinkSection,
  checked: Map<string, boolean>,
): Promise<void> {
  return rewriteChildLinks(app, parentFilePath, section, (b) =>
    checked.has(b) ? { checked: checked.get(b) } : undefined);
}

/**
 * Bring a parent's whole listing into line with `children`: each listed child's
 * title and box rewritten, the ones with no entry appended, the section's ID list
 * brought up to date. Reports whether anything was written.
 *
 * An unclaimed entry is dropped only when it resolves to a task note inside
 * `childFolder` — evidence the plugin put it there. Anything else is a link the user
 * wrote, indistinguishable here from a task note since deleted, so an unattended pass
 * leaves it; that one is `ProjectTaskFile.delete`'s to clean up, where the id is known.
 */
export async function syncChildLinks(
  app: App,
  parentFilePath: string,
  section: ChildLinkSection,
  children: ChildEntry[],
  childFolder: string,
): Promise<boolean> {
  const file = resolveFile(app, parentFilePath);
  if (!file) return false;

  const { frontmatterBlock, body } = splitFrontmatterBody(await app.vault.read(file));
  if (!frontmatterBlock) return false;

  const wanted = new Map(children.map((c) => [c.basename, c]));

  /** A stray entry the plugin owns: a task note of this parent's folder, gone elsewhere. */
  const hasDeparted = (basename: string): boolean => {
    const child = resolveFile(app, normalizePath(`${childFolder}/${basename}.md`));
    return !!child && app.metadataCache.getFileCache(child)?.frontmatter?.[Frontmatter.IsTask] === true;
  };

  // The ID list keeps the order it has, so a repair that changes nothing else can't
  // reshuffle a field obsidian-pm writes too, handing Sync a conflict for free.
  const fm = asFrontmatterRecord(app.metadataCache.getFileCache(file)?.frontmatter);
  const ids = stringArray(fm?.[section.idField]);
  const wantedIds = new Set(children.map((c) => c.id));
  const kept = ids.filter((id) => wantedIds.has(id));
  const newIds = [...kept, ...children.map((c) => c.id).filter((id) => !kept.includes(id))];

  // Guarded: `processFrontMatter` rewrites the file whatever the callback does, and
  // `touch` stamps `updatedAt` — calling it unconditionally would rewrite every note
  // in the vault on every pass, and wake the box handler once per note doing it.
  const idsChanged = newIds.length !== ids.length || newIds.some((id, i) => id !== ids[i]);
  if (idsChanged) {
    await app.fileManager.processFrontMatter(file, (m: Record<string, unknown>) => {
      m[section.idField] = newIds;
      touch(m);
    });
  }

  const newBody = rewriteSection(body, section, wanted, hasDeparted);
  if (newBody === body) return idsChanged;

  // `process` rather than read-then-modify: the frontmatter write above has already
  // moved the file, and a pass sweeping the whole vault widens every such window.
  await app.vault.process(file, (current) => {
    const split = splitFrontmatterBody(current);
    return split.frontmatterBlock ? split.frontmatterBlock + newBody : current;
  });
  return true;
}

/**
 * The body with the section's entries brought into line with `wanted`: each listed
 * child relabelled and reticked, each departed one dropped with its line, each child
 * with no entry appended. Line by line, so dropping an entry doesn't leave the blank
 * line behind that a regex replace would.
 */
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
    // Collapsed inside the section only: a dropped entry can leave the blank run its
    // line sat in, but spacing anywhere else in the note is the user's own.
    const inSection = rewritten.join("\n").replace(/\n{3,}/g, "\n\n");
    withinSection = body.slice(0, range.start) + inSection + body.slice(range.end);
  }

  const missing = [...wanted.values()]
    .filter((c) => !listed.has(c.basename))
    .map((c) => checklistItem(c.basename, c.title, c.checked));
  return appendEntries(withinSection, section, missing);
}

/**
 * Unregister a child from a parent file: drops its ID from the section's
 * frontmatter list and removes its checklist item, cleaning up the heading if it
 * leaves the section empty. Idempotent.
 *
 * Matches on `childBasename`, so this must run before any rename of the child.
 */
export async function removeChildLink(
  app: App,
  parentFilePath: string,
  section: ChildLinkSection,
  childId: string,
  childBasename: string,
): Promise<void> {
  const file = resolveFile(app, parentFilePath);
  if (!file) return;

  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    const current: string[] = stringArray(fm[section.idField]);
    fm[section.idField] = current.filter((id) => id !== childId);
    touch(fm);
  });

  await removeChildEntry(app, parentFilePath, section, childBasename);
}

/**
 * `removeChildLink` without the frontmatter half: drops the child's checklist line
 * only, cleaning up a heading it empties. Reports whether the entry was there.
 *
 * For an unlinking that has no id to prune — a task deleted outside the plugin, whose
 * file is already gone. The stale id is `syncChildLinks`' to drop on the next pass.
 *
 * `process` rather than read-then-modify: `unlinkDeletedTask` runs off the vault's
 * delete event, which fires part-way through `ProjectTaskFile.delete`, so this can be
 * editing the same note as the unlink that deletion is doing for itself.
 */
export async function removeChildEntry(
  app: App,
  parentFilePath: string,
  section: ChildLinkSection,
  childBasename: string,
): Promise<boolean> {
  const file = resolveFile(app, parentFilePath);
  if (!file) return false;

  let removed = false;
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
    removed = true;
    return frontmatterBlock + newBody;
  });
  return removed;
}
