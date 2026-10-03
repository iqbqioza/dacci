import type { NostrEvent } from "dacci-nostr-nips";
import { isComment, isRepost } from "dacci-nostr-nips";
import { For } from "solid-js";
import { withoutDeleted } from "./deleted.js";

/** The two tabs a feed offers, as Twitter does. */
export type FeedTab = "notes" | "replies";

/** What kind of post a feed entry is, for the tab split. */
export type FeedPostKind = "note" | "reply" | "comment" | "repost";

/**
 * Posts that belong to a conversation are labelled コメント, which is what
 * separates them from a standalone note everywhere cards are rendered.
 * That covers NIP-22 comments and plain NIP-10 replies alike.
 */
export function showsCommentLabel(event: NostrEvent): boolean {
  return isReply(event);
}

/**
 * A repost is labelled リポスト wherever cards are rendered, because its own
 * content is nothing: NIP-18 puts the reposted note in it as JSON, or leaves it
 * empty. A card with no body and no label reads as a post that failed to load.
 *
 * A quote repost — a repost carrying a `q` tag, with the quoter's own words in
 * the content — says 引用リポスト instead, so the two are told apart.
 */
export function showsRepostLabel(event: NostrEvent): boolean {
  return isRepost(event);
}

/** Whether this repost carries words of its own, which is what quoting is. */
export function isQuoteRepost(event: NostrEvent): boolean {
  return isRepost(event) && event.tags.some((tag) => tag[0] === "q");
}

/**
 * A post that answers or addresses someone is a reply: an `e` tag pointing
 * at another event, a `p` tag naming an author, or a NIP-22 comment. NIP-10
 * lets a client tag its own thread root with an `e` tag, so a tag pointing
 * at the event itself does not count.
 *
 * A repost is not one of those. It carries the `e` and `p` tags NIP-18 asks for,
 * so counted by the same rule every repost was a reply — labelled コメント, filed
 * under "Replies and notes", and shown on a page of conversation it has nothing
 * to do with. A repost answers nobody; it passes something on.
 */
export function isReply(event: NostrEvent): boolean {
  if (isRepost(event)) return false;
  if (isComment(event)) return true;
  return event.tags.some(
    (tag) => (tag[0] === "e" && tag[1] !== event.id) || tag[0] === "p",
  );
}

/**
 * Splits a post the way the tabs do: a note is a top-level kind 1, a reply
 * is a kind 1 answering another event, a comment is NIP-22 kind 1111, which
 * belongs with the replies, and a repost is NIP-18 kind 6 or 16.
 */
export function classifyFeedPost(event: NostrEvent): FeedPostKind {
  if (isRepost(event)) return "repost";
  if (isComment(event)) return "comment";
  if (isReply(event)) return "reply";
  return "note";
}

/**
 * The posts a tab shows, from everything the feed has loaded. No relay can
 * filter "has no e tag", so both tabs read the same events and the split
 * happens here instead of costing a second request.
 *
 * A repost is in both tabs, as it is on Twitter: it is not the author's own
 * words, so it is not a Note, and it answers nobody, so it is not a reply
 * either. Leaving it to either one tab hid it — Notes threw it away as not a
 * note, Replies and notes kept it labelled as a conversation it is not part of.
 *
 * Deleted posts are dropped here rather than in each feed, so a post the reader
 * deleted in another tab is gone from every tab and every feed at once.
 */
export function postsForTab(
  events: NostrEvent[],
  tab: FeedTab,
): NostrEvent[] {
  const shown = withoutDeleted(events);
  if (tab === "replies") return shown;
  return shown.filter((event) => {
    const kind = classifyFeedPost(event);
    return kind === "note" || kind === "repost";
  });
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
    <div class="flex border-b border-(--line) bg-(--surface)">
      <For each={TABS}>
        {(tab) => (
          <button
            class="flex-1 border-b-2 px-3 py-3 text-sm font-medium"
            classList={{
              "border-(--accent) text-(--accent)":
                props.tab === tab.id,
              "border-transparent text-(--ink-quiet)":
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
