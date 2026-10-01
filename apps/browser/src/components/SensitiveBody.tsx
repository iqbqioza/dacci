import { contentWarning, type NostrEvent } from "dacci-nostr-nips";
import { createMemo, createSignal, Show } from "solid-js";
import { useSensitiveMode } from "../sensitive.js";

/**
 * A post's body, kept behind a warning until the reader acts on it, as NIP-36
 * asks. The warning carries the author's own reason, so a reader who does want
 * the post is told what they are about to open.
 *
 * The blurred body stays in the document, which is what keeps the card from
 * resizing when it is revealed. A reader who wants the text out of reach
 * altogether picks the mode that does not render it.
 */
export function SensitiveBody(props: {
  /** The post whose warning decides whether the body is covered. */
  event: NostrEvent;
  children: unknown;
}) {
  const reason = createMemo(() => contentWarning(props.event));
  const mode = useSensitiveMode().mode;
  // Asking again is the point: a card that scrolls away and comes back is a
  // new reading of that post, not a continuation of the one they approved.
  const [revealed, setRevealed] = createSignal(false);
  const covered = createMemo(
    () => reason() !== null && mode() !== "show" && !revealed(),
  );

  return (
    <>
      <Show when={covered()}>
        {/* Outside the blur on purpose: the reason is what tells a reader
            whether they want the post, so blurring it would hide the only
            thing left to go on. */}
        <p class="mt-1 rounded-2xl border border-(--line) bg-(--fill-soft) px-3 py-2 text-sm text-(--ink-quiet)">
          <span class="font-bold text-(--ink)">
            {reason() === "" ? "センシティブコンテンツ" : reason()}
          </span>
          <Show when={mode() === "hide"}>
            <span> — この設定では表示されません</span>
          </Show>
          <Show when={mode() === "blur"}>
            <button
              type="button"
              class="ml-2 rounded-full border border-(--line-strong) px-2 py-0.5 text-xs text-(--ink-muted) hover:bg-(--surface)"
              onClick={(e) => {
                // The card itself opens the post, so the press that reveals
                // must not also navigate.
                e.stopPropagation();
                setRevealed(true);
              }}
            >
              表示する
            </button>
          </Show>
        </p>
      </Show>
      <Show when={!covered() || mode() !== "hide"}>
        <div class="mt-1" classList={{ "blur-sm select-none": covered() }}>
          {props.children as never}
        </div>
      </Show>
    </>
  );
}
