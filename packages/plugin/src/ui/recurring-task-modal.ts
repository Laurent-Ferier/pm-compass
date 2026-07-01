import { App, Modal } from "obsidian";
import type { RecurringTaskDefinition } from "../model/recurring-task";

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
export class RecurringTaskModal extends Modal {
  private readonly def: RecurringTaskDefinition;
  private readonly onSave: (result: RecurringTaskEditResult) => void;

  constructor(app: App, def: RecurringTaskDefinition, onSave: (result: RecurringTaskEditResult) => void) {
    super(app);
    this.def = def;
    this.onSave = onSave;
  }

  onOpen(): void {
    this.modalEl.addClass("pm-rtm-wrap");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pm-rtm");

    contentEl.createEl("h3", { text: "Edit recurring habit" });

    const titleInput = buildField(contentEl, "Title", (wrap) =>
      wrap.createEl("input", { type: "text" }),
    ) as HTMLInputElement;
    titleInput.value = this.def.title;

    const detailInput = buildField(contentEl, "Detail (indented sub-lines, optional)", (wrap) =>
      wrap.createEl("textarea"),
    ) as HTMLTextAreaElement;
    detailInput.value = this.def.detail;

    const btnRow = contentEl.createDiv({ cls: "pm-rtm-buttons" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = btnRow.createEl("button", { text: "Save", cls: "mod-cta" });
    saveBtn.addEventListener("click", () => {
      this.close();
      this.onSave({
        title: titleInput.value.trim() || this.def.title,
        detail: detailInput.value,
      });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
