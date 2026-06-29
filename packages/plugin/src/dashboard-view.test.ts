import { vi, describe, it, expect } from "vitest";

vi.mock("obsidian", () => ({
  App: class {},
  ItemView: class {
    contentEl = { empty: () => {}, createDiv: () => ({}) };
  },
  Menu: class {},
  TFile: class {},
  TAbstractFile: class {},
  WorkspaceLeaf: class {},
  normalizePath: (p: string) => p,
  setIcon: () => {},
  moment: Object.assign(() => ({ format: () => "", startOf: () => ({}) }), {
    isMoment: () => false,
  }),
}));

vi.mock("./task-creator", () => ({
  TaskModal: class {},
  ConfirmModal: class {},
  patchTaskField: vi.fn(),
  deleteTaskFile: vi.fn(),
  openDropdown: vi.fn(),
  openNoteFile: vi.fn(),
}));

vi.mock("./vault-reader", () => ({ loadVaultData: vi.fn() }));

vi.mock("./task-graph-view", () => ({
  TASK_GRAPH_VIEW_TYPE: "pm-compass-task-graph",
  TaskGraphView: class {},
}));

import { normalizeHabitKey } from "./dashboard-view";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHabitsTagRe(tag = "daily"): RegExp {
  return new RegExp(`\\s*#${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g");
}

// ---------------------------------------------------------------------------
// normalizeHabitKey
// ---------------------------------------------------------------------------

describe("normalizeHabitKey", () => {
  const re = makeHabitsTagRe("daily");

  describe("habits tag stripping", () => {
    it("strips the habits tag at the end", () => {
      expect(normalizeHabitKey("Morning run #daily", re)).toBe("Morning run");
    });

    it("strips the habits tag in the middle", () => {
      expect(normalizeHabitKey("Morning #daily run", re)).toBe("Morning run");
    });

    it("strips leading whitespace left by the habits tag", () => {
      expect(normalizeHabitKey("#daily Morning run", re)).toBe("Morning run");
    });

    it("does not strip a tag that only starts with the habit tag name", () => {
      const result = normalizeHabitKey("Read 30 min #dailyreading", re);
      expect(result).toBe("Read 30 min #dailyreading");
    });
  });

  describe("Tasks plugin emoji metadata stripping", () => {
    it("strips a completion date (✅ YYYY-MM-DD)", () => {
      expect(normalizeHabitKey("Morning run #daily ✅ 2024-01-15", re)).toBe("Morning run");
    });

    it("strips a due date (📅 YYYY-MM-DD)", () => {
      expect(normalizeHabitKey("Morning run #daily 📅 2024-06-01", re)).toBe("Morning run");
    });

    it("strips a scheduled date (⏳ YYYY-MM-DD)", () => {
      expect(normalizeHabitKey("Morning run #daily ⏳ 2024-06-01", re)).toBe("Morning run");
    });

    it("strips a start date (🛫 YYYY-MM-DD)", () => {
      expect(normalizeHabitKey("Morning run #daily 🛫 2024-06-01", re)).toBe("Morning run");
    });

    it("strips a created date (➕ YYYY-MM-DD)", () => {
      expect(normalizeHabitKey("Morning run #daily ➕ 2024-01-01", re)).toBe("Morning run");
    });

    it("strips a recurrence marker (🔁)", () => {
      expect(normalizeHabitKey("Morning run #daily 🔁 every day", re)).toBe("Morning run every day");
    });

    it("strips a critical priority emoji (🔺)", () => {
      expect(normalizeHabitKey("Morning run 🔺 #daily", re)).toBe("Morning run");
    });

    it("strips a high priority emoji (⏫)", () => {
      expect(normalizeHabitKey("Morning run ⏫ #daily", re)).toBe("Morning run");
    });

    it("strips a medium priority emoji (🔼)", () => {
      expect(normalizeHabitKey("Morning run 🔼 #daily", re)).toBe("Morning run");
    });

    it("strips a low priority emoji (🔽)", () => {
      expect(normalizeHabitKey("Morning run 🔽 #daily", re)).toBe("Morning run");
    });

    it("strips a lowest priority emoji (⏬)", () => {
      expect(normalizeHabitKey("Morning run ⏬ #daily", re)).toBe("Morning run");
    });

    it("strips a cancelled date (❌ YYYY-MM-DD)", () => {
      expect(normalizeHabitKey("Morning run #daily ❌ 2024-01-15", re)).toBe("Morning run");
    });

    it("strips multiple metadata fields in one pass", () => {
      expect(
        normalizeHabitKey("Morning run 🔺 #daily ➕ 2024-01-01 ✅ 2024-01-15", re),
      ).toBe("Morning run");
    });
  });

  describe("dataview inline field stripping", () => {
    it("strips bracket-style inline fields ([key:: value])", () => {
      expect(normalizeHabitKey("Morning run #daily [completion:: 2024-01-15]", re)).toBe("Morning run");
    });

    it("strips parenthesis-style inline fields ((key:: value))", () => {
      expect(normalizeHabitKey("Morning run #daily (due:: 2024-06-01)", re)).toBe("Morning run");
    });

    it("strips hyphenated key inline fields", () => {
      expect(normalizeHabitKey("Morning run #daily [due-date:: 2024-06-01]", re)).toBe("Morning run");
    });
  });

  describe("aggregation key stability", () => {
    it("produces the same key for identical text with different completion dates", () => {
      const a = normalizeHabitKey("Morning run #daily ✅ 2024-01-10", re);
      const b = normalizeHabitKey("Morning run #daily ✅ 2024-01-15", re);
      expect(a).toBe(b);
    });

    it("produces the same key for identical text with different priorities", () => {
      const a = normalizeHabitKey("Morning run 🔺 #daily", re);
      const b = normalizeHabitKey("Morning run 🔽 #daily", re);
      expect(a).toBe(b);
    });

    it("produces the same key regardless of whether metadata is present", () => {
      const withMeta = normalizeHabitKey("Morning run #daily ✅ 2024-01-15", re);
      const withoutMeta = normalizeHabitKey("Morning run #daily", re);
      expect(withMeta).toBe(withoutMeta);
    });

    it("produces the same key for text with combined emoji + dataview metadata", () => {
      const a = normalizeHabitKey("Read book #daily 🔺 [completion:: 2024-01-01]", re);
      const b = normalizeHabitKey("Read book #daily ⏬ (due:: 2024-06-01)", re);
      expect(a).toBe(b);
    });
  });

  describe("whitespace handling", () => {
    it("collapses multiple internal spaces left after metadata removal", () => {
      expect(normalizeHabitKey("Morning   run #daily", re)).toBe("Morning run");
    });

    it("trims leading and trailing whitespace", () => {
      expect(normalizeHabitKey("  Morning run #daily  ", re)).toBe("Morning run");
    });

    it("produces the same key when metadata removal leaves extra spaces", () => {
      const withGap = normalizeHabitKey("Morning run ✅ 2024-01-15 #daily", re);
      const clean = normalizeHabitKey("Morning run #daily", re);
      expect(withGap).toBe(clean);
    });

    it("produces the same key regardless of whitespace around the habits tag", () => {
      const a = normalizeHabitKey("Morning run #daily", re);
      const b = normalizeHabitKey("Morning run  #daily", re);
      expect(a).toBe(b);
    });
  });

  describe("custom habits tag", () => {
    it("respects a non-default habits tag", () => {
      const customRe = makeHabitsTagRe("habit");
      expect(normalizeHabitKey("Meditate #habit ✅ 2024-01-01", customRe)).toBe("Meditate");
    });

    it("leaves unrelated tags untouched", () => {
      const customRe = makeHabitsTagRe("habit");
      expect(normalizeHabitKey("Meditate #habit #wellness ✅ 2024-01-01", customRe)).toBe("Meditate #wellness");
    });
  });
});
