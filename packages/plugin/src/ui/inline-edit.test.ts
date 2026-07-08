// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { wireCommitOnKey } from "./inline-edit";

function makeInput(): HTMLInputElement {
  const input = document.createElement("input");
  document.body.appendChild(input);
  return input;
}

describe("wireCommitOnKey", () => {
  it("calls commit (not cancel) on a plain blur", () => {
    const input = makeInput();
    const commit = vi.fn();
    const cancel = vi.fn();
    wireCommitOnKey(input, (ke) => ke.key === "Enter", commit, cancel);

    input.dispatchEvent(new FocusEvent("blur"));

    expect(commit).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("blurs (triggering commit) when the commit key is pressed", () => {
    const input = makeInput();
    const commit = vi.fn();
    const cancel = vi.fn();
    wireCommitOnKey(input, (ke) => ke.key === "Enter", commit, cancel);
    input.focus();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(commit).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("does not commit or cancel for keys other than the commit key or Escape", () => {
    const input = makeInput();
    const commit = vi.fn();
    const cancel = vi.fn();
    wireCommitOnKey(input, (ke) => ke.key === "Enter", commit, cancel);
    input.focus();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));

    expect(commit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels without committing on Escape, even though it also blurs", () => {
    const input = makeInput();
    const commit = vi.fn();
    const cancel = vi.fn();
    wireCommitOnKey(input, (ke) => ke.key === "Enter", commit, cancel);
    input.focus();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(cancel).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  it("commits when the element is torn out of the DOM mid-edit, simulated via blur", () => {
    // This is the desired behavior: losing focus for any reason (including an unrelated
    // re-render tearing this element out of the DOM) commits whatever is currently typed —
    // only Escape discards it.
    const input = makeInput();
    const commit = vi.fn();
    const cancel = vi.fn();
    wireCommitOnKey(input, (ke) => ke.key === "Enter", commit, cancel);
    input.focus();

    input.remove();
    input.dispatchEvent(new FocusEvent("blur"));

    expect(commit).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("does not commit on a blur that happens after Escape already cancelled", () => {
    const input = makeInput();
    const commit = vi.fn();
    const cancel = vi.fn();
    wireCommitOnKey(input, (ke) => ke.key === "Enter", commit, cancel);
    input.focus();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    // A later, separate blur (e.g. from an unrelated re-render) must not re-trigger commit.
    input.dispatchEvent(new FocusEvent("blur"));

    expect(commit).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("respects a custom isCommitKey predicate (e.g. Ctrl/Cmd+Enter for multi-line fields)", () => {
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    const commit = vi.fn();
    const cancel = vi.fn();
    wireCommitOnKey(textarea, (ke) => ke.key === "Enter" && (ke.metaKey || ke.ctrlKey), commit, cancel);
    textarea.focus();

    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(commit).not.toHaveBeenCalled();

    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }));
    expect(commit).toHaveBeenCalledOnce();
  });
});
