import type { NostrEvent } from "dacci-nostr-nips";
import { formatTime, shortId } from "../nostr.js";

export function EventCard(props: {
  event: NostrEvent;
  onSelect: (event: NostrEvent) => void;
}) {
  return (
    <article
      class="cursor-pointer border-b border-(--dads-solid-gray-200) px-4 py-3 hover:bg-(--dads-blue-50)"
      onClick={() => props.onSelect(props.event)}
    >
      <div class="flex items-baseline gap-2 text-sm">
        <span class="font-mono text-(--dads-solid-gray-700)">
          {shortId(props.event.pubkey)}
        </span>
        <span class="text-(--dads-solid-gray-500)">
          {formatTime(props.event.created_at)}
        </span>
      </div>
      <p class="mt-1 whitespace-pre-wrap break-words text-(--dads-solid-gray-900)">
        {props.event.content}
      </p>
    </article>
  );
}
