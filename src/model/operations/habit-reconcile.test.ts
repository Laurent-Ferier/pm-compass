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
    const { app, store } = makeDayVault({ "f.md": "# Routine\n- [ ] Other habit" });
    const { inserted, removedCount } = await reconcileRecurringHabits(app, "f.md",
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
    const { app, store } = makeDayVault({ "f.md": "# Routine\n- [ ] Morning run #daily" });
    const { inserted, removedCount } = await reconcileRecurringHabits(app, "f.md",
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
    const { app, store } = makeDayVault({ "f.md": "Some note content" });
    await reconcileRecurringHabits(app, "f.md",
      [habitDef()],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(store.get("f.md")).toBe("Some note content\n\n# Routine\n- [ ] Morning run #daily");
  });

  it("appends the heading and habit to a completely empty note", async () => {
    const { app, store } = makeDayVault({ "f.md": "" });
    await reconcileRecurringHabits(app, "f.md",
      [habitDef()],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(store.get("f.md")).toBe("\n# Routine\n- [ ] Morning run #daily");
  });

  it("includes detail sub-lines when inserting", async () => {
    const { app, store } = makeDayVault({ "f.md": "# Routine" });
    await reconcileRecurringHabits(app, "f.md",
      [habitDef({ detail: "Prompt A\nPrompt B" })],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(store.get("f.md")).toBe("# Routine\n- [ ] Morning run #daily\n\tPrompt A\n\tPrompt B");
  });

  it("skips a habit not scheduled for that weekday", async () => {
    const { app, store } = makeDayVault({ "f.md": "# Routine" });
    const weekdaysMonToFri = 0b0011111;
    const { inserted } = await reconcileRecurringHabits(app, "f.md",
      [habitDef({ weekdays: weekdaysMonToFri })],
      day("2026-07-05"), // Sunday
      "# Routine",
      TAG,
    );
    expect(inserted).toEqual([]);
    expect(store.get("f.md")).toBe("# Routine");
  });

  it("removes a habit line whose definition was deleted entirely", async () => {
    const { app, store } = makeDayVault({
      "f.md": "# Routine\n- [ ] Morning run #daily\n- [ ] Other habit",
    });
    const { removedCount } = await reconcileRecurringHabits(app, "f.md",
      [], // Morning run's definition no longer exists
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(removedCount).toBe(1);
    expect(store.get("f.md")).toBe("# Routine\n- [ ] Other habit");
  });

  it("removes a habit line whose definition was deactivated", async () => {
    const { app, store } = makeDayVault({ "f.md": "# Routine\n- [ ] Morning run #daily" });
    const { removedCount } = await reconcileRecurringHabits(app, "f.md",
      [habitDef({ active: false })],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(removedCount).toBe(1);
    expect(store.get("f.md")).toBe("# Routine");
  });

  it("removes a habit line no longer scheduled for that weekday", async () => {
    const { app, store } = makeDayVault({ "f.md": "# Routine\n- [ ] Morning run #daily" });
    const weekdaysMonToFri = 0b0011111;
    const { removedCount } = await reconcileRecurringHabits(app, "f.md",
      [habitDef({ weekdays: weekdaysMonToFri })],
      day("2026-07-05"), // Sunday — not in Mon-Fri
      "# Routine",
      TAG,
    );
    expect(removedCount).toBe(1);
    expect(store.get("f.md")).toBe("# Routine");
  });

  it("removes a habit line whose title was renamed, along with its sub-lines", async () => {
    const { app, store } = makeDayVault({
      "f.md": "# Routine\n- [ ] Old title #daily\n\tOld detail\n- [ ] Other habit",
    });
    const { removedCount } = await reconcileRecurringHabits(app, "f.md",
      [habitDef({ title: "New title" })],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(removedCount).toBe(1);
    expect(store.get("f.md")).toBe("# Routine\n- [ ] Other habit\n- [ ] New title #daily");
  });

  it("does not remove a checked habit line whose definition still matches", async () => {
    const { app, store } = makeDayVault({ "f.md": "# Routine\n- [x] Morning run #daily ✅ 2026-06-29" });
    const { removedCount } = await reconcileRecurringHabits(app, "f.md",
      [habitDef()],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(removedCount).toBe(0);
    expect(store.get("f.md")).toBe("# Routine\n- [x] Morning run #daily ✅ 2026-06-29");
  });

  it("removes orphaned habit-tagged lines outside the heading section too (backward compatibility)", async () => {
    const { app, store } = makeDayVault({
      "f.md": "- [ ] Morning run #daily\n# Routine\n- [ ] Other habit",
    });
    const { removedCount } = await reconcileRecurringHabits(app, "f.md",
      [], // no definitions at all — the stray line above the heading is still orphaned
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(removedCount).toBe(1);
    expect(store.get("f.md")).toBe("# Routine\n- [ ] Other habit");
  });

  it("inserts a missing habit before a trailing --- divider, not after it", async () => {
    const { app, store } = makeDayVault({
      "f.md": "# Routine\n- [ ] Other habit\n---\nSome other section",
    });
    const { inserted } = await reconcileRecurringHabits(app, "f.md",
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
    const { app, store } = makeDayVault({
      "f.md": "# Routine\n- [ ] Other habit\n---\n- [ ] Morning run #daily",
    });
    const { removedCount } = await reconcileRecurringHabits(app, "f.md",
      [], // no definitions — the tagged line past the divider is still orphaned
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(removedCount).toBe(1);
    expect(store.get("f.md")).toBe("# Routine\n- [ ] Other habit\n---");
  });

  it("does not duplicate an inserted habit when two instances reconcile the same file concurrently", async () => {
    // Regression test: main.ts's file-open handler and the dashboard's backfill call each
    // call the pass for the same path. Without serializing
    // mutations per path, both would read the file before either write lands, both decide
    // the habit is missing, and both insert it — leaving a duplicate line.
    const { app, store } = makeDayVault({ "f.md": "# Routine" });
    await Promise.all([
      reconcileRecurringHabits(app, "f.md",
        [habitDef()],
        day("2026-06-29"),
        "# Routine",
        TAG,
      ),
      reconcileRecurringHabits(app, "f.md",
        [habitDef()],
        day("2026-06-29"),
        "# Routine",
        TAG,
      ),
    ]);
    expect(store.get("f.md")).toBe("# Routine\n- [ ] Morning run #daily");
  });
});
