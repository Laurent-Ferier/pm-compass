import { App } from "obsidian";
import { PmModal } from "./pm-modal";
import type { RecurringTaskDefinition } from "../model/daily/recurring-task";

export interface RecurringTaskEditResult {
  title: string;
  detail: string;
}

function buildField(
  parent: HTMLElement,
  labelText: string,
  build: (wrap: HTMLElement) => HTMLInputElement | HTMLTextAreaElement,
): HTMLInputElement | HTMLTextAreaElement {
  const row = parent.createDiv({ cls: "pm-rtm-row" });
  row.createEl("label", { text: labelText });
  return build(row);
}

/** Small modal for editing a recurring habit definition's title/detail fields. */
export class RecurringTaskModal extends PmModal {
  private readonly def: RecurringTaskDefinition;
  private readonly onSave: (result: RecurringTaskEditResult) => void;

  protected readonly confirmLabel = "Save";

  private titleInput!: HTMLInputElement;
  private detailInput!: HTMLTextAreaElement;

  constructor(app: App, def: RecurringTaskDefinition, onSave: (result: RecurringTaskEditResult) => void) {
    super(app);
    this.def = def;
    this.onSave = onSave;
  }

  protected build(contentEl: HTMLElement): void {
    this.modalEl.addClass("pm-rtm-wrap");
    contentEl.addClass("pm-rtm");

    contentEl.createEl("h3", { text: "Edit recurring habit" });

    this.titleInput = buildField(contentEl, "Title", (wrap) =>
      wrap.createEl("input", { type: "text" }),
    ) as HTMLInputElement;
    this.titleInput.value = this.def.title;

    this.detailInput = buildField(contentEl, "Detail (indented sub-lines, optional)", (wrap) =>
      wrap.createEl("textarea"),
    ) as HTMLTextAreaElement;
    this.detailInput.value = this.def.detail;
  }

  protected confirm(): void {
    this.close();
    this.onSave({
      title: this.titleInput.value.trim() || this.def.title,
      detail: this.detailInput.value,
    });
  }
}
