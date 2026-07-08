import { describe, it, expect } from "vitest";
import { getStatusColor, getPriorityColor, escapeHtml, stripWikiLinks, withAlpha } from "./task-vocabulary";

// ---------------------------------------------------------------------------
// getStatusColor
// ---------------------------------------------------------------------------

describe("getStatusColor", () => {
  it("returns the correct colour for each known status", () => {
    expect(getStatusColor("todo")).toBe("#6b7280");
    expect(getStatusColor("in-progress")).toBe("#3b82f6");
    expect(getStatusColor("blocked")).toBe("#ef4444");
    expect(getStatusColor("review")).toBe("#8b5cf6");
    expect(getStatusColor("done")).toBe("#22c55e");
    expect(getStatusColor("cancelled")).toBe("#9ca3af");
  });

  it("falls back to the todo grey for an unknown status", () => {
    expect(getStatusColor("unknown")).toBe("#6b7280");
    expect(getStatusColor("")).toBe("#6b7280");
  });
});

// ---------------------------------------------------------------------------
// getPriorityColor
// ---------------------------------------------------------------------------

describe("getPriorityColor", () => {
  it("returns the correct colour for each known priority", () => {
    expect(getPriorityColor("critical")).toBe("#ef4444");
    expect(getPriorityColor("high")).toBe("#f97316");
    expect(getPriorityColor("medium")).toBe("#eab308");
    expect(getPriorityColor("low")).toBe("#22c55e");
  });

  it("returns an empty string for undefined", () => {
    expect(getPriorityColor(undefined)).toBe("");
  });

  it("returns an empty string for an unrecognised priority", () => {
    expect(getPriorityColor("ultra")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes less-than signs", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes greater-than signs", () => {
    expect(escapeHtml("a > b")).toBe("a &gt; b");
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('say "hi"')).toBe("say &quot;hi&quot;");
  });

  it("escapes all characters in a combined string", () => {
    expect(escapeHtml('<a href="x&y">text</a>')).toBe(
      "&lt;a href=&quot;x&amp;y&quot;&gt;text&lt;/a&gt;",
    );
  });

  it("returns the string unchanged when there is nothing to escape", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("handles an empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// stripWikiLinks
// ---------------------------------------------------------------------------

describe("stripWikiLinks", () => {
  it("replaces a plain wiki-link with its page name", () => {
    expect(stripWikiLinks("See [[Some Page]] for details")).toBe("See Some Page for details");
  });

  it("replaces a piped wiki-link with its display text", () => {
    expect(stripWikiLinks("See [[some-page|Some Page]] for details")).toBe("See Some Page for details");
  });

  it("trims whitespace around the page/display text", () => {
    expect(stripWikiLinks("[[ some-page | Some Page ]]")).toBe("Some Page");
  });

  it("replaces multiple wiki-links in the same string", () => {
    expect(stripWikiLinks("[[a|Alpha]] and [[b|Beta]]")).toBe("Alpha and Beta");
  });

  it("returns the string unchanged when there are no wiki-links", () => {
    expect(stripWikiLinks("no links here")).toBe("no links here");
  });
});

// ---------------------------------------------------------------------------
// withAlpha
// ---------------------------------------------------------------------------

describe("withAlpha", () => {
  it("appends the alpha hex to a six-digit colour", () => {
    expect(withAlpha("#3b82f6", "22")).toBe("#3b82f622");
  });

  it("expands a three-digit colour before appending alpha", () => {
    expect(withAlpha("#f00", "80")).toBe("#ff000080");
  });

  it("works without a leading '#'", () => {
    expect(withAlpha("3b82f6", "ff")).toBe("#3b82f6ff");
  });

  it("handles a three-digit shorthand without '#'", () => {
    expect(withAlpha("abc", "44")).toBe("#aabbcc44");
  });

  it("handles a fully opaque alpha (ff)", () => {
    expect(withAlpha("#22c55e", "ff")).toBe("#22c55eff");
  });

  it("handles a fully transparent alpha (00)", () => {
    expect(withAlpha("#22c55e", "00")).toBe("#22c55e00");
  });
});
