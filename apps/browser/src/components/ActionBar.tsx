import type { NostrEvent } from "dacci-nostr-nips";
import { For, Show } from "solid-js";
import { openQuote, openReply, react, repost } from "../compose.js";
import { hasDone } from "../my-actions.js";
import { Icon, type IconName } from "./Icon.jsx";

interface Action {
  kind: "reply" | "repost" | "quote" | "react";
  icon: IconName;
  /** Shown when the action has not been taken yet. */
  label: string;
  /** Shown once the reader has taken it. */
  doneLabel: string;
  /** Colour of the glyph after the action. */
  doneClass: string;
  run: (event: NostrEvent) => void;
}

const ACTIONS: Action[] = [
  {
    kind: "reply",
    icon: "reply",
    label: "リプライ",
    doneLabel: "リプライ済み",
    doneClass: "text-(--dads-blue-700)",
    run: (event) => openReply(event),
  },
  {
    kind: "repost",
    icon: "repost",
    label: "リポスト",
    doneLabel: "リポスト済み",
    doneClass: "text-(--dads-blue-700)",
    run: (event) => void repost(event),
  },
  {
    kind: "quote",
    icon: "quote-repost",
    label: "引用付きリポスト",
    doneLabel: "引用済み",
    doneClass: "text-(--dads-blue-700)",
    run: (event) => openQuote(event),
  },
  {
    kind: "react",
    icon: "react",
    label: "リアクション",
    doneLabel: "リアクション済み",
    doneClass: "text-(--dads-red-600)",
    run: (event) => void react(event),
  },
];

/**
 * Action row under the post body: four equal columns, centred glyphs, no
 * counts. Every feed card uses it, so the row is identical everywhere.
 *
 * A taken action keeps its colour and its filled glyph, so the reader can
 * always tell which posts they have already acted on.
 */
export function ActionBar(props: { event: NostrEvent }) {
  const id = () => props.event.id;
  const labelOf = (action: Action): string =>
    hasDone(action.kind, id()) ? action.doneLabel : action.label;

  return (
    // No rule above the row: the buttons sit directly under the text, and
    // the negative bottom margin reclaims the card's own padding so the row
    // does not leave a large gap above the border.
    <div class="mt-1.5 -mb-1.5 grid grid-cols-4">
      <For each={ACTIONS}>
        {(action) => (
          <button
            type="button"
            title={labelOf(action)}
            aria-label={labelOf(action)}
            aria-pressed={hasDone(action.kind, id())}
            class={`flex items-center justify-center rounded-full py-1.5 ${
              hasDone(action.kind, id())
                ? action.doneClass
                : "text-(--dads-solid-gray-500) hover:bg-(--dads-blue-50) hover:text-(--dads-blue-700)"
            }`}
            onClick={(e) => {
              // The card itself opens the detail view.
              e.stopPropagation();
              action.run(props.event);
            }}
          >
            <Show
              when={action.kind !== "react" || !hasDone(action.kind, id())}
              fallback={<Icon name="react-solid" class="size-5" filled />}
            >
              <Icon name={action.icon} class="size-5" />
            </Show>
          </button>
        )}
      </For>
    </div>
  );
}
