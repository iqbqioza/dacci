import type { NostrEvent } from "dacci-nostr-nips";
import { Show } from "solid-js";
import { useEmbed } from "../embeds.js";
import { formatTime } from "../nostr.js";
import { ProfileAvatar, ProfileName } from "./ProfileAvatar.jsx";

/**
 * The note a repost or a quote repost points at, shown as a bordered card
 * inside the post. NIP-18 embeds are the quoter's own words in the outer
 * card, so this stays deliberately quiet: author, time and a clipped body,
 * with no action row of its own, because the outer card owns the actions.
 */
export function EmbeddedCard(props: {
  /** The repost or quote repost whose note is shown. */
  event: NostrEvent;
  onSelect: (event: NostrEvent) => void;
}) {
  const embed = () => useEmbed(props.event);
  const quoted = () => embed().event;

  return (
    <Show when={quoted()} keyed>
      {(note) => (
        <div
          class="mt-2 cursor-pointer overflow-hidden rounded-2xl border border-(--dads-solid-gray-200) hover:bg-(--dads-blue-50)"
          onClick={(e) => {
            // The outer card opens the repost; the embed opens the note.
            e.stopPropagation();
            props.onSelect(note);
          }}
        >
          <div class="flex gap-2 p-3">
            <ProfileAvatar pubkey={note.pubkey} size={32} />
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline justify-between gap-2">
                <ProfileName pubkey={note.pubkey} class="text-sm" />
                <span class="shrink-0 text-xs whitespace-nowrap text-(--dads-solid-gray-500)">
                  {formatTime(note.created_at)}
                </span>
              </div>
              <p class="mt-0.5 line-clamp-4 text-sm break-words whitespace-pre-wrap text-(--dads-solid-gray-900)">
                {note.content}
              </p>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}

/**
 * Placeholder shown while the embedded note is still being fetched. It keeps
 * the card's height stable so a feed does not jump when the note arrives,
 * and says plainly when no relay has the note, instead of spinning forever.
 */
export function EmbeddedPlaceholder(props: { event: NostrEvent }) {
  return (
    <Show when={useEmbed(props.event).loading}>
      <div
        class="mt-2 rounded-2xl border border-(--dads-solid-gray-200) px-3 py-2.5 text-sm text-(--dads-solid-gray-500)"
        aria-live="polite"
      >
        引用元を読み込み中…
      </div>
    </Show>
  );
}
