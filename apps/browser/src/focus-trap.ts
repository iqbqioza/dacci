/**
 * Keeping the keyboard inside a dialog.
 *
 * A dialog that says `aria-modal="true"` has told assistive technology the page
 * behind it is inert. Nothing made it so: the scrim covers the page and takes a
 * click, but a Tab from the last control inside walked straight on into the page
 * being covered — a dozen fields, the nav, the whole feed. That is worse than
 * saying nothing, because the reader has been told otherwise.
 *
 * The trap is the Tab key alone. Everything else is already handled where it
 * belongs: Escape closes, and a click outside is the scrim's own work. Only the
 * one key that walks past a scrim needs help.
 */

/**
 * What can hold focus, and so what a Tab may land on.
 *
 * `not([disabled])` is there because a disabled control is skipped by the
 * browser's own Tab, and one listed here would be counted as the end of the row
 * and trap the reader against a control they cannot press.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * The controls inside a panel, in the order Tab would reach them.
 *
 * Recomputed on every Tab rather than kept, because the answer changes while the
 * dialog is open: the profile editor reveals fields as the store answers, the
 * compose form swaps its target for a quoted post, and the upload picker adds a
 * row when a server is added. A list taken once would wrap the reader around a
 * control that is no longer there.
 */
function reachable(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    // A control the browser would never land on is not an end of the row. An
    // element with no boxes is laid out as `display: none`, or is a `hidden`
    // field; either way Tab passes over it, and counting it would make the trap
    // put focus somewhere unreachable.
    (el) => el.getClientRects().length > 0,
  );
}

/**
 * Holds the keyboard inside `panel` until the returned function is called.
 *
 * Registered in the capture phase, so the answer is given before anything inside
 * the dialog gets to see the key. A control that stops propagation — which is
 * exactly what a rich text field or an emoji picker does with keys it wants for
 * itself — would otherwise let the reader walk out on its last Tab.
 */
export function trapFocus(panel: HTMLElement): () => void {
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Tab") return;
    const items = reachable(panel);
    if (items.length === 0) {
      // Nothing to move to, so hold the reader where they are rather than let
      // the key carry them out onto the page.
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && panel.contains(active);
    // Focus outside the panel is the case worth catching even before the first
    // and last Tab: the dialog can be opened with the keyboard and then have
    // focus moved out of it by anything that focuses something on mount.
    if (!inside) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", onKey, true);
  return () => document.removeEventListener("keydown", onKey, true);
}