import type { NostrEvent } from "dacci-nostr-nips";
import { formatTime } from "../nostr.js";
import { ProfileAvatar, ProfileName } from "./ProfileAvatar.jsx";

/**
 * Every post in the app uses this card: the author's icon in the left column
 * and the post in the right column, so timelines and notifications read the
 * same way.
 */
export function EventCard(props: {
  event: NostrEvent;
  onSelect: (event: NostrEvent) => void;
}) {
  return (
    <article
      class="flex cursor-pointer gap-3 border-b border-(--dads-solid-gray-200) px-4 py-3 hover:bg-(--dads-blue-50)"
      onClick={() => props.onSelect(props.event)}
    >
      <ProfileAvatar pubkey={props.event.pubkey} />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-baseline gap-x-2">
          <ProfileName pubkey={props.event.pubkey} />
          <span class="text-xs text-(--dads-solid-gray-500)">
            {formatTime(props.event.created_at)}
          </span>
        </div>
        <p class="mt-0.5 whitespace-pre-wrap break-words text-(--dads-solid-gray-900)">
          {props.event.content}
        </p>
      </div>
    </article>
  );
}
