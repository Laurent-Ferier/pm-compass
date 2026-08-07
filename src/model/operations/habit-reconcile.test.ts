import { vi, describe, it, expect } from "vitest";

vi.mock("obsidian", async () => ({
  App: class {},
  TFile: class {},
  Notice: class {},
  normalizePath: (p: string) => p,
  // Imported inside the factory: this call is hoisted above the file's own imports.
  moment: (await import("../__testing__/day-moment")).dayMoment,
}));

import { reconcileRecurringHabits } from "./habit-reconcile";
import { day } from "../__testing__/dates";
import { makeDayVault } from "../__testing__/day-vault";
import type { RecurringTaskDefinition } from "../daily/recurring-task";
import { ALL_WEEKDAYS } from "../daily/recurring-task";

// ---------------------------------------------------------------------------
// reconcileRecurringHabits
// ---------------------------------------------------------------------------

describe("reconcileRecurringHabits", () => {
  const TAG = "daily";

  function habitDef(overrides: Partial<RecurringTaskDefinition> = {}): RecurringTaskDefinition {
    return {
      id: "id-1",
      title: "Morning run",
      weekdays: ALL_WEEKDAYS,
      order: 0,
      active: true,
      createdAt: day("2026-01-01"),
      detail: "",
      ...overrides,
    };
  }

  it("inserts a missing habit under the existing heading", async () => {
    const { store, files } = makeDayVault({ "f.md": "# Routine\n- [ ] Other habit" });
    const { inserted, removedCount } = await reconcileRecurringHabits(files.file("f.md"),
      [habitDef()],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(inserted).toHaveLength(1);
    expect(removedCount).toBe(0);
    expect(store.get("f.md")).toBe("# Routine\n- [ ] Other habit\n- [ ] Morning run #daily");
  });

  it("does nothing when the habit is already present", async () => {
    const { store, files } = makeDayVault({ "f.md": "# Routine\n- [ ] Morning run #daily" });
    const { inserted, removedCount } = await reconcileRecurringHabits(files.file("f.md"),
      [habitDef()],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(inserted).toEqual([]);
    expect(removedCount).toBe(0);
    expect(store.get("f.md")).toBe("# Routine\n- [ ] Morning run #daily");
  });

  it("appends the heading and habit when no heading exists yet", async () => {
    const { store, files } = makeDayVault({ "f.md": "Some note content" });
    await reconcileRecurringHabits(files.file("f.md"),
      [habitDef()],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(store.get("f.md")).toBe("Some note content\n\n# Routine\n- [ ] Morning run #daily");
  });

  it("appends the heading and habit to a completely empty note", async () => {
    const { store, files } = makeDayVault({ "f.md": "" });
    await reconcileRecurringHabits(files.file("f.md"),
      [habitDef()],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(store.get("f.md")).toBe("\n# Routine\n- [ ] Morning run #daily");
  });

  it("includes detail sub-lines when inserting", async () => {
    const { store, files } = makeDayVault({ "f.md": "# Routine" });
    await reconcileRecurringHabits(files.file("f.md"),
      [habitDef({ detail: "Prompt A\nPrompt B" })],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(store.get("f.md")).toBe("# Routine\n- [ ] Morning run #daily\n\tPrompt A\n\tPrompt B");
  });

  it("skips a habit not scheduled for that weekday", async () => {
    const { store, files } = makeDayVault({ "f.md": "# Routine" });
    const weekdaysMonToFri = 0b0011111;
    const { inserted } = await reconcileRecurringHabits(files.file("f.md"),
      [habitDef({ weekdays: weekdaysMonToFri })],
      day("2026-07-05"), // Sunday
      "# Routine",
      TAG,
    );
    expect(inserted).toEqual([]);
    expect(store.get("f.md")).toBe("# Routine");
  });

  it("removes a habit line whose definition was deleted entirely", async () => {
    const { store, files } = makeDayVault({
      "f.md": "# Routine\n- [ ] Morning run #daily\n- [ ] Other habit",
    });
    const { removedCount } = await reconcileRecurringHabits(files.file("f.md"),
      [], // Morning run's definition no longer exists
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(removedCount).toBe(1);
    expect(store.get("f.md")).toBe("# Routine\n- [ ] Other habit");
  });

  it("removes a habit line whose definition was deactivated", async () => {
    const { store, files } = makeDayVault({ "f.md": "# Routine\n- [ ] Morning run #daily" });
    const { removedCount } = await reconcileRecurringHabits(files.file("f.md"),
      [habitDef({ active: false })],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(removedCount).toBe(1);
    expect(store.get("f.md")).toBe("# Routine");
  });

  it("removes a habit line no longer scheduled for that weekday", async () => {
    const { store, files } = makeDayVault({ "f.md": "# Routine\n- [ ] Morning run #daily" });
    const weekdaysMonToFri = 0b0011111;
    const { removedCount } = await reconcileRecurringHabits(files.file("f.md"),
      [habitDef({ weekdays: weekdaysMonToFri })],
      day("2026-07-05"), // Sunday — not in Mon-Fri
      "# Routine",
      TAG,
    );
    expect(removedCount).toBe(1);
    expect(store.get("f.md")).toBe("# Routine");
  });

  it("removes a habit line whose title was renamed, along with its sub-lines", async () => {
    const { store, files } = makeDayVault({
      "f.md": "# Routine\n- [ ] Old title #daily\n\tOld detail\n- [ ] Other habit",
    });
    const { removedCount } = await reconcileRecurringHabits(files.file("f.md"),
      [habitDef({ title: "New title" })],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(removedCount).toBe(1);
    expect(store.get("f.md")).toBe("# Routine\n- [ ] Other habit\n- [ ] New title #daily");
  });

  it("does not remove a checked habit line whose definition still matches", async () => {
    const { store, files } = makeDayVault({ "f.md": "# Routine\n- [x] Morning run #daily ✅ 2026-06-29" });
    const { removedCount } = await reconcileRecurringHabits(files.file("f.md"),
      [habitDef()],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(removedCount).toBe(0);
    expect(store.get("f.md")).toBe("# Routine\n- [x] Morning run #daily ✅ 2026-06-29");
  });

  it("removes orphaned habit-tagged lines outside the heading section too (backward compatibility)", async () => {
    const { store, files } = makeDayVault({
      "f.md": "- [ ] Morning run #daily\n# Routine\n- [ ] Other habit",
    });
    const { removedCount } = await reconcileRecurringHabits(files.file("f.md"),
      [], // no definitions at all — the stray line above the heading is still orphaned
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(removedCount).toBe(1);
    expect(store.get("f.md")).toBe("# Routine\n- [ ] Other habit");
  });

  it("inserts a missing habit before a trailing --- divider, not after it", async () => {
    const { store, files } = makeDayVault({
      "f.md": "# Routine\n- [ ] Other habit\n---\nSome other section",
    });
    const { inserted } = await reconcileRecurringHabits(files.file("f.md"),
      [habitDef()],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(inserted).toHaveLength(1);
    expect(store.get("f.md")).toBe(
      "# Routine\n- [ ] Other habit\n- [ ] Morning run #daily\n---\nSome other section",
    );
  });

  it("removes orphaned habit-tagged lines past a --- divider too", async () => {
    const { store, files } = makeDayVault({
      "f.md": "# Routine\n- [ ] Other habit\n---\n- [ ] Morning run #daily",
    });
    const { removedCount } = await reconcileRecurringHabits(files.file("f.md"),
      [], // no definitions — the tagged line past the divider is still orphaned
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(removedCount).toBe(1);
    expect(store.get("f.md")).toBe("# Routine\n- [ ] Other habit\n---");
  });

  // ── The order the definitions call for ─────────────────────────────────────
  //
  // A section that doesn't read as the definitions say is taken out and put back whole:
  // every habit removed, then the ordered list inserted. Each line the note already had
  // goes back as it stood, which is what keeps a tick, its stamp and its sub-lines.

  const a = () => habitDef({ id: "a", title: "A", order: 0 });
  const b = () => habitDef({ id: "b", title: "B", order: 1 });

  const reconcile = (files: ReturnType<typeof makeDayVault>["files"], defs: RecurringTaskDefinition[]) =>
    reconcileRecurringHabits(files.file("f.md"), defs, day("2026-06-29"), "# Routine", TAG);

  it("puts habit lines back in the definitions' order, in one write", async () => {
    const { store, writes, files } = makeDayVault({ "f.md": "# Routine\n- [ ] B #daily\n- [ ] A #daily" });
    const { inserted, removedCount, changed } = await reconcile(files, [a(), b()]);

    expect(store.get("f.md")).toBe("# Routine\n- [ ] A #daily\n- [ ] B #daily");
    // Two lines dropped and a section put back, and the note never reads as either half:
    // whatever re-reads it in between would set about putting the missing habits back.
    expect(writes).toEqual(["f.md"]);
    // Nothing was added or orphaned — the note changed all the same.
    expect(inserted).toEqual([]);
    expect(removedCount).toBe(0);
    expect(changed).toBe(true);
  });

  it("keeps each reordered habit's tick, stamp and sub-lines", async () => {
    const { store, files } = makeDayVault({
      "f.md": "# Routine\n- [x] B #daily ✅ 2026-06-29\n\tnote under B\n- [ ] A #daily",
    });
    await reconcile(files, [a(), b()]);

    expect(store.get("f.md")).toBe(
      "# Routine\n- [ ] A #daily\n- [x] B #daily ✅ 2026-06-29\n\tnote under B",
    );
  });

  it("takes the order from the definitions' order field, not the array's", async () => {
    const { store, files } = makeDayVault({
      "f.md": "# Routine\n- [ ] A #daily\n- [ ] B #daily\n- [ ] C #daily",
    });
    await reconcile(files, [
      habitDef({ id: "a", title: "A", order: 2 }),
      habitDef({ id: "b", title: "B", order: 0 }),
      habitDef({ id: "c", title: "C", order: 1 }),
    ]);

    expect(store.get("f.md")).toBe("# Routine\n- [ ] B #daily\n- [ ] C #daily\n- [ ] A #daily");
  });

  it("lands a newly inserted habit in its place among the ones already there", async () => {
    const { store, files } = makeDayVault({ "f.md": "# Routine\n- [ ] B #daily" });
    const { inserted } = await reconcile(files, [a(), b()]);

    expect(inserted.map((d) => d.id)).toEqual(["a"]);
    expect(store.get("f.md")).toBe("# Routine\n- [ ] A #daily\n- [ ] B #daily");
  });

  it("writes the section after a line that isn't a habit's, that line staying put", async () => {
    const { store, files } = makeDayVault({ "f.md": "# Routine\n- [ ] B #daily\nsome note" });
    await reconcile(files, [a(), b()]);

    expect(store.get("f.md")).toBe("# Routine\nsome note\n- [ ] A #daily\n- [ ] B #daily");
  });

  it("leaves a habit moved out of the section where it was put, and writes it nowhere else", async () => {
    const { store, files } = makeDayVault({
      "f.md": "- [ ] A #daily\n# Routine\n- [ ] B #daily",
    });
    const { inserted, changed } = await reconcile(files, [a(), b()]);

    expect(inserted).toEqual([]);
    expect(changed).toBe(false);
    expect(store.get("f.md")).toBe("- [ ] A #daily\n# Routine\n- [ ] B #daily");
  });

  it("writes nothing at all when the section already reads as the definitions say", async () => {
    const { store, writes, files } = makeDayVault({
      "f.md": "# Routine\n- [ ] A #daily\n- [ ] B #daily",
    });
    const { changed } = await reconcile(files, [a(), b()]);

    expect(writes).toEqual([]);
    expect(changed).toBe(false);
    expect(store.get("f.md")).toBe("# Routine\n- [ ] A #daily\n- [ ] B #daily");
  });

  it("takes its lines from under the lock, not from a reading a tick has moved on from", async () => {
    // Regression test: the pass reads the note once to see whether there is anything to do,
    // and a tick landing right after would leave every habit line it means to take out
    // resolving against text the file no longer holds — the section put back from the stale
    // lines, the habit written twice, the tick lost with the duplicate.
    const { app, store, files } = makeDayVault({ "f.md": "# Routine\n- [ ] B #daily\n- [ ] A #daily" });
    vi.spyOn(app.vault, "read").mockImplementationOnce(async (file) => {
      const content = store.get(file.path) ?? "";
      store.set(file.path, content.replace("- [ ] A #daily", "- [x] A #daily ✅ 2026-06-29"));
      return content;
    });
    await reconcile(files, [a(), b()]);

    expect(store.get("f.md")).toBe("# Routine\n- [x] A #daily ✅ 2026-06-29\n- [ ] B #daily");
  });

  it("does not duplicate an inserted habit when two instances reconcile the same file concurrently", async () => {
    // Regression test: main.ts's file-open handler and the dashboard's backfill call each
    // call the pass for the same path. Without serializing
    // mutations per path, both would read the file before either write lands, both decide
    // the habit is missing, and both insert it — leaving a duplicate line.
    const { store, files } = makeDayVault({ "f.md": "# Routine" });
    await Promise.all([
      reconcileRecurringHabits(files.file("f.md"),
        [habitDef()],
        day("2026-06-29"),
        "# Routine",
        TAG,
      ),
      reconcileRecurringHabits(files.file("f.md"),
        [habitDef()],
        day("2026-06-29"),
        "# Routine",
        TAG,
      ),
    ]);
    expect(store.get("f.md")).toBe("# Routine\n- [ ] Morning run #daily");
  });
});
