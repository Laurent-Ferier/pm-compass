/** Wires an inline-edit control (input or textarea) so losing focus always commits the
 *  change via `commit`, and only Escape rolls it back via `cancel`. `isCommitKey` forces
 *  an immediate blur (and thus a commit) — e.g. Enter for a single-line field, or
 *  Ctrl/Cmd+Enter for a multi-line one where plain Enter must still insert a newline. */
export function wireCommitOnKey(
  el: HTMLInputElement | HTMLTextAreaElement,
  isCommitKey: (ke: KeyboardEvent) => boolean,
  commit: () => void,
  cancel: () => void,
): void {
  let cancelled = false;
  el.addEventListener("blur", () => {
    if (!cancelled) commit();
  });
  el.addEventListener("keydown", ((ke: KeyboardEvent) => {
    if (isCommitKey(ke)) {
      ke.preventDefault();
      el.blur();
    } else if (ke.key === "Escape") {
      ke.preventDefault();
      cancelled = true;
      cancel();
      el.blur();
    }
  }) as EventListener);
}
