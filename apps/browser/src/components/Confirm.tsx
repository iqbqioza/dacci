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
  createEffect(() => {
    if (!props.open) return;
    // Escape is the way out of anything that asks, so it has to work here too.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onCancel();
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  return (
    <Show when={props.open}>
      {/* A modal, so it sits above the pinned bars: the page behind it must not
          be reachable while a question is being answered. */}
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-(--scrim)"
        // A click on the scrim is a change of mind; a click on the dialog is
        // not, so it is stopped from reaching the scrim.
        onClick={props.onCancel}
      >
        <div
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