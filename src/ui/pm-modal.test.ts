// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll } from "vitest";
import { bagOf } from "./__testing__/dom-bag";

function installObsidianDOMPolyfills() {
  const htmlProto = bagOf(HTMLElement.prototype);

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
    return this.createEl("div", opts);
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
    // `declare`, so this only names what the subclass under test defines — a real field
    // here would be initialised to undefined and shadow the subclass's own method.
    declare onOpen?: () => void;
    declare onClose?: () => void;
    open() { this.onOpen?.(); }
    close() { this.onClose?.(); }
  }
  return { MockModal };
});

vi.mock("obsidian", () => ({
  App: class {},
  Modal: MockModal,
}));

import { ConfirmStyle, PmModal } from "./pm-modal";
import { asApp } from "../model/__testing__/as-app";

const APP = asApp({});

/** A dialog with one field, standing in for the real ones. */
class TestModal extends PmModal {
  protected readonly confirmLabel = "Save";
  readonly confirmed = vi.fn();
  field!: HTMLTextAreaElement;

  protected build(contentEl: HTMLElement): void {
    this.field = contentEl.createEl("textarea");
  }

  protected confirm(): void {
    this.confirmed();
  }

  /** The buttons, which the base keeps protected. */
  get buttons(): { confirm: HTMLButtonElement; cancel: HTMLButtonElement } {
    return { confirm: this.confirmBtn, cancel: this.cancelBtn };
  }

  refuse(): void {
    this.confirmBtn.disabled = true;
  }
}

function open(): TestModal {
  const modal = new TestModal(APP);
  modal.open();
  return modal;
}

function press(el: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

describe("PmModal", () => {
  it("puts the footer under the body, Cancel before confirm", () => {
    const modal = open();

    const children = [...modal.contentEl.children];
    expect(children.at(-1)?.className).toBe("pm-modal-buttons");
    const buttons = [...modal.contentEl.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toEqual(["Cancel", "Save"]);
  });

  it("labels and styles the confirm button", () => {
    const modal = open();

    expect(modal.buttons.confirm.className).toBe(`pm-modal-confirm ${ConfirmStyle.Cta}`);
    expect(modal.buttons.confirm.textContent).toBe("Save");
  });

  it("confirms on a click and closes on Cancel", () => {
    const modal = open();
    const closeSpy = vi.spyOn(modal, "close");

    modal.buttons.confirm.click();
    expect(modal.confirmed).toHaveBeenCalledOnce();

    modal.buttons.cancel.click();
    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it("confirms on Shift+Enter from a field inside the dialog", () => {
    const modal = open();

    const e = press(modal.field, { shiftKey: true });

    expect(modal.confirmed).toHaveBeenCalledOnce();
    expect(e.defaultPrevented).toBe(true);
  });

  it("leaves plain Enter to the field", () => {
    const modal = open();

    const e = press(modal.field, {});

    expect(modal.confirmed).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("stands back when the field already handled the key", () => {
    const modal = open();
    modal.field.addEventListener("keydown", (e) => e.preventDefault());

    press(modal.field, { shiftKey: true });

    expect(modal.confirmed).not.toHaveBeenCalled();
  });

  it("does nothing on Shift+Enter while confirm is disabled", () => {
    const modal = open();
    modal.refuse();

    const e = press(modal.field, { shiftKey: true });

    expect(modal.confirmed).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("confirms once per Shift+Enter after a reopen", () => {
    const modal = open();
    modal.close();
    modal.open();

    press(modal.field, { shiftKey: true });

    expect(modal.confirmed).toHaveBeenCalledOnce();
  });

  it("empties contentEl on close", () => {
    const modal = open();

    modal.close();

    expect(modal.contentEl.innerHTML).toBe("");
  });
});
