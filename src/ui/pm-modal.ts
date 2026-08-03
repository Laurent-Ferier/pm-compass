import { App, Modal } from "obsidian";

/** How the confirm button looks — Obsidian's own button styles. `Warning` is for an
 *  action that destroys something; everything else is the accent `Cta`. */
export enum ConfirmStyle {
  Cta = "mod-cta",
  Warning = "mod-warning",
}

/**
 * What every pm-compass dialog shares: a body of its own, then one Cancel/confirm row at
 * the bottom, Shift+Enter as the confirm shortcut, and an emptied `contentEl` on close.
 * Cancel needs no wiring — Obsidian's Modal already closes on Escape.
 *
 * A subclass fills the body in `build` and says in `confirm` what confirming means;
 * everything below that is this class's business.
 */
export abstract class PmModal extends Modal {
  /** The footer's buttons. They exist before `build` runs, so a dialog that opens with
   *  its action refused just disables the confirm one — the shortcut honours that
   *  exactly as a click would. */
  protected confirmBtn!: HTMLButtonElement;
  protected cancelBtn!: HTMLButtonElement;

  /** What the confirm button says. */
  protected abstract readonly confirmLabel: string;

  /** The confirm button's looks. */
  protected confirmStyle = ConfirmStyle.Cta;

  /** Fills the dialog above its footer. */
  protected abstract build(contentEl: HTMLElement): void;

  /** Runs on confirm, whether by the button or by the shortcut. Closing is the dialog's
   *  own business, since some confirms fail and stay open. */
  protected abstract confirm(): void;

  constructor(app: App) {
    super(app);
    // `contentEl` outlives a close, so the shortcut is wired once here rather than per
    // open, where reopening the same dialog would pile a listener on with every open.
    this.wireConfirmShortcut();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    // The footer goes up first, so `build` can reach the confirm button, and is moved
    // back under the body once that is there.
    const footer = this.buildFooter(contentEl);
    this.build(contentEl);
    contentEl.appendChild(footer);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private buildFooter(contentEl: HTMLElement): HTMLElement {
    const row = contentEl.createDiv({ cls: "pm-modal-buttons" });
    this.cancelBtn = row.createEl("button", { cls: "pm-modal-cancel", text: "Cancel" });
    this.cancelBtn.addEventListener("click", () => this.close());
    this.confirmBtn = row.createEl("button", {
      cls: `pm-modal-confirm ${this.confirmStyle}`,
      text: this.confirmLabel,
    });
    this.confirmBtn.addEventListener("click", () => this.confirm());
    return row;
  }

  /** Shift+Enter anywhere in the dialog presses its confirm button. Plain Enter is left
   *  to whatever field the cursor sits in — a newline in a textarea, a link suggestion,
   *  an inline chip — so a field that already handled the key keeps it, and a disabled
   *  button stays inert. Before the first open there is no button, and no dialog either. */
  private wireConfirmShortcut(): void {
    this.contentEl.addEventListener("keydown", ((e: KeyboardEvent) => {
      if (e.key !== "Enter" || !e.shiftKey || e.defaultPrevented || this.confirmBtn?.disabled !== false) return;
      e.preventDefault();
      this.confirmBtn.click();
    }) as EventListener);
  }
}
