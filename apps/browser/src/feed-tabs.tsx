import type { NostrEvent } from "dacci-nostr-nips";
import { isComment } from "dacci-nostr-nips";
import { For } from "solid-js";

/** The two tabs a feed offers, as Twitter does. */
export type FeedTab = "notes" | "replies";

/** What kind of post a feed entry is, for the tab split. */
export type FeedPostKind = "note" | "reply" | "comment";

/**
 * Posts that belong to a conversation are labelled コメント, which is what
 * separates them from a standalone note everywhere cards are rendered.
 * That covers NIP-22 comments and plain NIP-10 replies alike.
 */
export function showsCommentLabel(event: NostrEvent): boolean {
  return isReply(event);
}

/**
 * A post that answers or addresses someone is a reply: an `e` tag pointing
 * at another event, a `p` tag naming an author, or a NIP-22 comment. NIP-10
 * lets a client tag its own thread root with an `e` tag, so a tag pointing
 * at the event itself does not count.
 */
export function isReply(event: NostrEvent): boolean {
  if (isComment(event)) return true;
  return event.tags.some(
    (tag) => (tag[0] === "e" && tag[1] !== event.id) || tag[0] === "p",
  );
}

/**
 * Splits a post the way the tabs do: a note is a top-level kind 1, a reply
 * is a kind 1 answering another event, and a comment is NIP-22 kind 1111,
 * which belongs with the replies.
 */
export function classifyFeedPost(event: NostrEvent): FeedPostKind {
  if (isComment(event)) return "comment";
  if (isReply(event)) return "reply";
  return "note";
}

/**
 * The posts a tab shows, from everything the feed has loaded. No relay can
 * filter "has no e tag", so both tabs read the same events and the split
 * happens here instead of costing a second request.
 */
export function postsForTab(
  events: NostrEvent[],
  tab: FeedTab,
): NostrEvent[] {
  if (tab === "replies") return events;
  return events.filter((event) => classifyFeedPost(event) === "note");
}

const TABS: Array<{ id: FeedTab; label: string }> = [
  { id: "notes", label: "Notes" },
  { id: "replies", label: "Replies and notes" },
];

/**
 * The tab row, shared by the home feed and a profile so both read exactly
 * the same. It carries no positioning of its own: a caller that wants it
 * pinned wraps it together with any bar below in one sticky container, so
 * the two stack instead of covering each other.
 */
export function FeedTabs(props: {
  tab: FeedTab;
  onSelect: (tab: FeedTab) => void;
}) {
  return (
    <div class="flex border-b border-(--dads-solid-gray-200) bg-white">
      <For each={TABS}>
        {(tab) => (
          <button
            class="flex-1 border-b-2 px-3 py-3 text-sm font-medium"
            classList={{
              "border-(--dads-blue-700) text-(--dads-blue-700)":
                props.tab === tab.id,
              "border-transparent text-(--dads-solid-gray-600)":
                props.tab !== tab.id,
            }}
            onClick={() => props.onSelect(tab.id)}
          >
            {tab.label}
          </button>
        )}
      </For>
    </div>
  );
}
