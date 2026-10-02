import { createEffect, onCleanup, Show } from "solid-js";

/**
 * A question asked before something that cannot be taken back. Deleting a post
 * publishes a NIP-09 request, and no relay is obliged to serve the post again,
 * so the reader is asked once rather than given a row that fires straight away.
 *
 * The answer is the dialog's own: the caller hands in what to do, so the same
 * dialog serves every question instead of each caller building its own.
 */
export function Confirm(props: {
  open: boolean;
  title: string;
  /** What will happen, in the reader's terms rather than the protocol's. */
  body: string;
  /** The answer that does it, so the button says what it does. */
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // The dialog is not in the DOM until `open` turns true, so its parts can only
  // be named after the effect has run.
  let cancelButton: HTMLButtonElement | undefined;
  let panel: HTMLDivElement | undefined;

  createEffect(() => {
    if (!props.open) return;
    // Escape is the way out of anything that asks, so it has to work here too.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onCancel();
    };
    document.addEventListener("keydown", onKey);
    // The scrim covers the page, so focus has to come inside: left where it
    // was, the next Tab walks the feed behind the question instead of the two
    // answers in it. "やめる" is where it goes, because that is the answer that
    // undoes nothing.
    const before = document.activeElement;
    // Named now, while the dialog is still in the document. By the time this
    // effect cleans up the panel has been taken out of the page, and a detached
    // node's ancestors are not worth walking: the card it belonged to is the
    // thing the reader was working on, and it is focusable.
    const card = panel?.closest<HTMLElement>("[tabindex]") ?? null;
    queueMicrotask(() => {
      cancelButton?.focus();
    });
    onCleanup(() => {
      document.removeEventListener("keydown", onKey);
      // And hand it back, so a reader who answered or dismissed is returned to
      // the card they came from rather than dropped at the top of the page.
      //
      // The button that opened the question is usually gone by now: it was a row
      // in an overflow menu, and taking the row closed the menu. So the card the
      // dialog sits in is the fallback — it is focusable, and it is the thing
      // the reader was working on.
      const target =
        before instanceof HTMLElement &&
        before !== document.body &&
        before.isConnected
          ? before
          : card;
      // On the next tick, not now: removing the dialog takes the focused button
      // with it, and the browser puts focus back on the body when that happens.
      // Restoring first would simply be undone by the removal.
      queueMicrotask(() => {
        target?.focus();
      });
    });
  });

  return (
    <Show when={props.open}>
      {/* A modal, so it sits above the pinned bars: the page behind it must not
          be reachable while a question is being answered. */}
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-(--scrim)"
        // A click on the scrim is a change of mind; a click on the dialog is
        // not, so it is stopped from reaching the scrim.
        //
        // The scrim has to stop there as well. `Confirm` is opened from inside a
        // post card, and `position: fixed` moves the box without moving the
        // node, so the scrim is a descendant of the card that opens the
        // question: a click that only means "never mind" would go on to open that
        // post. Solid delegates events and walks the captured `composedPath()`,
        // ending the walk where `cancelBubble` is set — so this is what keeps the
        // card's own `onClick` from running, and it holds even though `onCancel`
        // tears the scrim out of the document first.
        onClick={(e) => {
          e.stopPropagation();
          props.onCancel();
        }}
      >
        <div
          ref={panel}
          class="w-full max-w-sm rounded-2xl bg-(--surface) p-4"
          role="dialog"
          aria-modal="true"
          aria-label={props.title}
          onClick={(e) => e.stopPropagation()}
        >
          <h2 class="font-bold">{props.title}</h2>
          <p class="mt-2 text-sm text-(--ink-muted)">{props.body}</p>
          <div class="mt-4 flex justify-end gap-2">
            <button
              ref={cancelButton}
              type="button"
              class="rounded-2xl border border-(--line-strong) px-4 py-2"
              onClick={props.onCancel}
            >
              やめる
            </button>
            <button
              type="button"
              class="rounded-2xl bg-(--danger) px-4 py-2 text-(--on-danger)"
              onClick={props.onConfirm}
            >
              {props.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}