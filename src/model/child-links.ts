import { App } from "obsidian";
import { resolveFile, splitFrontmatterBody, stringArray, touch } from "./file-helpers";

/**
 * Identifies where a parent file records its children. Tasks track subtasks in
 * `subtaskIds` / `## Subtasks`; projects track root tasks in `taskIds` / `## Tasks`.
 * Both use the same `- [ ] [[basename|title]]` checklist format.
 */
export interface ChildLinkSection {
  /** Frontmatter field holding the child ID list. */
  idField: string;
  /** Body heading introducing the checklist, including the `##` prefix. */
  heading: string;
}

export const SUBTASK_SECTION: ChildLinkSection = { idField: "subtaskIds", heading: "## Subtasks" };
export const PROJECT_TASK_SECTION: ChildLinkSection = { idField: "taskIds", heading: "## Tasks" };

function checklistItem(basename: string, title: string): string {
  return `- [ ] [[${basename}|${title}]]`;
}

/**
 * Matches this child's checklist item. The `|title` alias is optional: the
 * plugin always writes one, but a hand-edited `[[slug]]` must still be found,
 * or removal would silently leave it behind.
 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function linkRegex(basename: string): RegExp {
  return new RegExp(`\\n?- \\[ \\] \\[\\[${escapeRe(basename)}(?:\\|[^\\]]*)?\\]\\]`, "g");
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

/**
 * Register a child inside a parent file: appends its ID to the section's
 * frontmatter list and a checklist item under the section heading, creating the
 * heading when absent.
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

  const newItem = checklistItem(childBasename, childTitle);
  const range = sectionRange(body, section.heading);

  if (!range) {
    // No section yet: start one at the end.
    const trimmed = body.trimEnd();
    const newBody = (trimmed ? trimmed + "\n\n" : "") + section.heading + "\n" + newItem + "\n";
    await app.vault.modify(file, frontmatterBlock + newBody);
    return;
  }

  const before = body.slice(0, range.start);
  const inSection = body.slice(range.start, range.end);
  const after = body.slice(range.end);

  // A link to this child may already sit in the section under a stale title;
  // refresh it in place rather than appending a duplicate.
  if (linkRegex(childBasename).test(inSection)) {
    const replaced = inSection.replace(linkRegex(childBasename), "\n" + newItem);
    if (replaced !== inSection) await app.vault.modify(file, frontmatterBlock + before + replaced + after);
    return;
  }

  const appended = inSection.trimEnd() + "\n" + newItem + "\n";
  const newBody = after ? before + appended + "\n" + after.trimStart() : before + appended;
  await app.vault.modify(file, frontmatterBlock + newBody);
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

  const raw = await app.vault.read(file);
  const { frontmatterBlock, body } = splitFrontmatterBody(raw);
  if (!frontmatterBlock) return;

  const range = sectionRange(body, section.heading);
  if (!range) return;

  const before = body.slice(0, range.start);
  const inSection = body.slice(range.start, range.end);
  const after = body.slice(range.end);

  const stripped = inSection.replace(linkRegex(childBasename), "");
  if (stripped === inSection) return;

  let newBody = before + stripped + after;
  const emptyHeading = new RegExp(`\\n?${escapeRe(section.heading)}\\n(?=\\n|$)`);
  newBody = newBody.replace(emptyHeading, "").replace(/\n{3,}/g, "\n\n");
  await app.vault.modify(file, frontmatterBlock + newBody);
}
