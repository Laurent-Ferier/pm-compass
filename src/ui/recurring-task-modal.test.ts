// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll } from "vitest";

function installObsidianDOMPolyfills() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const htmlProto = HTMLElement.prototype as any;

  type CreateElOpts = { cls?: string; text?: string; type?: string };

  function createElOn(this: Element, tag: string, opts?: CreateElOpts): Element {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    if (opts?.text) el.textContent = opts.text;
    if (opts?.type) (el as HTMLInputElement).type = opts.type;
    this.appendChild(el);
    return el;
  }

  htmlProto.createEl = createElOn;
  htmlProto.createDiv = function (this: HTMLElement, opts?: CreateElOpts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).createEl("div", opts);
  };
  htmlProto.addClass = function (this: HTMLElement, cls: string) {
    this.classList.add(cls);
  };
  htmlProto.empty = function (this: HTMLElement) {
    this.innerHTML = "";
  };
}

beforeAll(() => {
  installObsidianDOMPolyfills();
});

const { MockModal } = vi.hoisted(() => {
  class MockModal {
    app: unknown;
    contentEl: HTMLElement;
    modalEl: HTMLElement;
    constructor(app: unknown) {
      this.app = app;
      this.contentEl = document.createElement("div");
      this.modalEl = document.createElement("div");
      this.modalEl.appendChild(this.contentEl);
      document.body.appendChild(this.modalEl);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    open() { (this as any).onOpen?.(); }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    close() { (this as any).onClose?.(); }
  }
  return { MockModal };
});

vi.mock("obsidian", () => ({
  App: class {},
  Modal: MockModal,
}));

import { RecurringTaskModal } from "./recurring-task-modal";
import type { RecurringTaskDefinition } from "../model/recurring-task";

const APP = {} as never;

function makeDef(overrides: Partial<RecurringTaskDefinition> = {}): RecurringTaskDefinition {
  return {
    id: "id-1",
    title: "Morning run",
    weekdays: 0b1111111,
    order: 0,
    active: true,
    createdAt: "2026-01-01",
    detail: "",
    ...overrides,
  };
}

describe("RecurringTaskModal", () => {
  it("pre-fills the title and detail fields from the definition", () => {
    const def = makeDef({ title: "Morning run", detail: "Warm up first" });
    const modal = new RecurringTaskModal(APP, def, () => {});
    modal.open();
    const input = modal.contentEl.querySelector("input[type='text']") as HTMLInputElement;
    const textarea = modal.contentEl.querySelector("textarea") as HTMLTextAreaElement;
    expect(input.value).toBe("Morning run");
    expect(textarea.value).toBe("Warm up first");
  });

  it("saves the trimmed title/detail and closes on Save click", () => {
    const def = makeDef({ title: "Morning run" });
    const onSave = vi.fn();
    const modal = new RecurringTaskModal(APP, def, onSave);
    const closeSpy = vi.spyOn(modal, "close");
    modal.open();
    const input = modal.contentEl.querySelector("input[type='text']") as HTMLInputElement;
    const textarea = modal.contentEl.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "  Evening run  ";
    textarea.value = "Stretch after";
    const saveBtn = Array.from(modal.contentEl.querySelectorAll("button")).find((b) => b.textContent === "Save")!;
    saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(closeSpy).toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledWith({ title: "Evening run", detail: "Stretch after" });
  });

  it("falls back to the original title when the input is cleared to blank", () => {
    const def = makeDef({ title: "Morning run" });
    const onSave = vi.fn();
    const modal = new RecurringTaskModal(APP, def, onSave);
    modal.open();
    const input = modal.contentEl.querySelector("input[type='text']") as HTMLInputElement;
    input.value = "   ";
    const saveBtn = Array.from(modal.contentEl.querySelectorAll("button")).find((b) => b.textContent === "Save")!;
    saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSave).toHaveBeenCalledWith({ title: "Morning run", detail: "" });
  });

  it("closes without saving on Cancel click", () => {
    const def = makeDef();
    const onSave = vi.fn();
    const modal = new RecurringTaskModal(APP, def, onSave);
    const closeSpy = vi.spyOn(modal, "close");
    modal.open();
    const cancelBtn = Array.from(modal.contentEl.querySelectorAll("button")).find((b) => b.textContent === "Cancel")!;
    cancelBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(closeSpy).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("empties contentEl on close", () => {
    const def = makeDef();
    const modal = new RecurringTaskModal(APP, def, () => {});
    modal.open();
    modal.close();
    expect(modal.contentEl.innerHTML).toBe("");
  });
});
