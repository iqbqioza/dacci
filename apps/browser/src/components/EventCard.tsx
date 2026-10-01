import type { NostrEvent } from "dacci-nostr-nips";
import { displayContent, encodeNpub } from "dacci-nostr-nips";
import { Show, createEffect, createMemo } from "solid-js";
import { requestEmbeds } from "../embeds.js";
import { showsCommentLabel } from "../feed-tabs.jsx";
import { formatTime } from "../nostr.js";
import { navigate, profileHash } from "../router.js";
import { ActionBar } from "./ActionBar.jsx";
import { EmbeddedCard, EmbeddedPlaceholder } from "./EmbeddedCard.jsx";
import { ProfileAvatar, ProfileName } from "./ProfileAvatar.jsx";
import { PostMenu } from "./PostMenu.jsx";

/**
 * Every post in the app uses this card: the author's icon in the left column
 * and the post in the right column, so timelines, notifications and a note's
 * own page read the same way. The header carries the name with its npub
 * underneath, the time and the overflow menu on the right.
 *
 * A feed clips nothing, because a post is one of many. A detail page is the
 * only view of that post, so `detailed` drops the hover affordances and lets
 * the text use the full width: a long note is what the reader came for.
 */
export function EventCard(props: {
  event: NostrEvent;
  onSelect: (event: NostrEvent) => void;
  /** The post's own page: no hover styling, wider text, no hover cursor. */
  detailed?: boolean;
}) {
  const npub = createMemo(() => encodeNpub(props.event.pubkey));

  // A repost or a quote repost shows the note it points at. The store
  // coalesces every card on screen into one batched query.
  createEffect(() => {
    requestEmbeds([props.event]);
  });

  // A feed separates its entries with a rule; a detail page has only one
  // entry, so the same rule closes the post instead of dividing it.
  const surface = (): string =>
    props.detailed === true
      ? "flex gap-3 border-b border-(--dads-solid-gray-200) px-4 py-4"
      : "flex cursor-pointer gap-3 border-b border-(--dads-solid-gray-200) px-4 py-3 hover:bg-(--dads-blue-50)";

  return (
    <article
      class={surface()}
      onClick={() => {
        // On its own page the post is already open, so clicking must not
        // navigate to the very same route.
        if (props.detailed !== true) props.onSelect(props.event);
      }}
    >
      <ProfileAvatar pubkey={props.event.pubkey} />
      <div class="min-w-0 flex-1">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <button
              class="block max-w-full text-left hover:underline"
              title="プロフィールを開く"
              onClick={(e) => {
                // Opening the profile must not open the post as well.
                e.stopPropagation();
                navigate(profileHash(props.event.pubkey));
              }}
            >
              <ProfileName pubkey={props.event.pubkey} />
            </button>
            <p
              class="truncate font-mono text-xs text-(--dads-solid-gray-500)"
              title={npub() ?? props.event.pubkey}
            >
              {npub() ?? props.event.pubkey}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            {/* A post that answers another one is labelled コメント, so a
                conversation is told apart from a standalone note. */}
            <Show when={showsCommentLabel(props.event)}>
              <span class="rounded-md bg-(--dads-solid-gray-100) px-1.5 py-0.5 text-xs text-(--dads-solid-gray-600)">
                コメント
              </span>
            </Show>
            <span class="text-xs whitespace-nowrap text-(--dads-solid-gray-500)">
              {formatTime(props.event.created_at)}
            </span>
            <PostMenu event={props.event} onOpen={props.onSelect} />
          </div>
        </div>
        {/* The note shown as an embed below replaces its `nostr:` link, so
            the text drops that link rather than printing it twice. A feed
            never clips it either: a long note is the reader's whole reason
            for opening the post. */}
        <p class="mt-1 whitespace-pre-wrap break-words text-(--dads-solid-gray-900)">
          {displayContent(props.event)}
        </p>
        <EmbeddedCard event={props.event} onSelect={props.onSelect} />
        <EmbeddedPlaceholder event={props.event} />
        <ActionBar event={props.event} />
      </div>
    </article>
  );
}
