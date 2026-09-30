import type { NostrEvent } from "dacci-nostr-nips";
import { encodeNpub } from "dacci-nostr-nips";
import { createMemo } from "solid-js";
import { formatTime } from "../nostr.js";
import { ActionBar } from "./ActionBar.jsx";
import { ProfileAvatar, ProfileName } from "./ProfileAvatar.jsx";
import { PostMenu } from "./PostMenu.jsx";

/**
 * Every post in the app uses this card: the author's icon in the left column
 * and the post in the right column, so timelines and notifications read the
 * same way. The header carries the name with its npub underneath, the time
 * and the overflow menu on the right.
 */
export function EventCard(props: {
  event: NostrEvent;
  onSelect: (event: NostrEvent) => void;
}) {
  const npub = createMemo(() => encodeNpub(props.event.pubkey));

  return (
    <article
      class="flex cursor-pointer gap-3 border-b border-(--dads-solid-gray-200) px-4 py-3 hover:bg-(--dads-blue-50)"
      onClick={() => props.onSelect(props.event)}
    >
      <ProfileAvatar pubkey={props.event.pubkey} />
      <div class="min-w-0 flex-1">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <ProfileName pubkey={props.event.pubkey} />
            <p
              class="truncate font-mono text-xs text-(--dads-solid-gray-500)"
              title={npub() ?? props.event.pubkey}
            >
              {npub() ?? props.event.pubkey}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <span class="text-xs whitespace-nowrap text-(--dads-solid-gray-500)">
              {formatTime(props.event.created_at)}
            </span>
            <PostMenu event={props.event} onOpen={props.onSelect} />
          </div>
        </div>
        <p class="mt-1 whitespace-pre-wrap break-words text-(--dads-solid-gray-900)">
          {props.event.content}
        </p>
        <ActionBar event={props.event} />
      </div>
    </article>
  );
}
