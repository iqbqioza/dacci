import type { NostrEvent } from "dacci-nostr-nips";
import { Show } from "solid-js";
import { useEmbed, useEmbedLoading } from "../embeds.js";
import { formatTime } from "../nostr.js";
import { NoteBody } from "./NoteBody.jsx";
import { ProfileAvatar, ProfileName } from "./ProfileAvatar.jsx";
import { SensitiveBody } from "./SensitiveBody.jsx";

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
          class="mt-2 cursor-pointer overflow-hidden rounded-2xl border border-(--line) hover:bg-(--accent-soft)"
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
                <span class="shrink-0 text-xs whitespace-nowrap text-(--ink-muted)">
                  {formatTime(note.created_at)}
                </span>
              </div>
              {/* A quoted note is a post of its own, so it carries its own
                  NIP-36 warning: the outer post asking for approval says
                  nothing about what it quotes. */}
              <SensitiveBody event={note}>
                <p class="line-clamp-4 text-sm break-words whitespace-pre-wrap text-(--ink)">
                  {/* The embed shows no note of its own, so a link to a post
                      that is not rendered here stays in the quoted text. */}
                  <NoteBody event={note} />
                </p>
              </SensitiveBody>
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
  // The cheap question. Asking `useEmbed` for this flag re-read the note, and
  // reading a note inline in a repost means verifying a signature — so the
  // placeholder was paying for work it does not use, once per card per render.
  const loading = useEmbedLoading(props.event);
  return (
    <Show when={loading()}>
      <div
        class="mt-2 rounded-2xl border border-(--line) px-3 py-2.5 text-sm text-(--ink-muted)"
        aria-live="polite"
      >
        引用元を読み込み中…
      </div>
    </Show>
  );
}
