import type { NostrEvent } from "dacci-nostr-nips";
import { createSignal } from "solid-js";
import { rememberEvents } from "./event-cache.js";
import { getConnection } from "./nostr.js";
import { commentReplyParent, directReplies, replyParent } from "./replies.js";
import { useRelays } from "./relays.js";

/**
 * The direct answers to one post, kept per post id at module level so
 * moving between two posts and back does not refetch.
 */
const [replies, setReplies] = createSignal<Map<string, NostrEvent[]>>(
  new Map(),
);
const [loading, setLoading] = createSignal(false);
const [searched, setSearched] = createSignal(false);

/** Posts already asked about, so a revisit never queries again. */
const asked = new Set<string>();

/**
 * Asks the read relays for anything pointing at `postId`.
 *
 * A relay indexes a NIP-10 reply and a NIP-22 comment under the event the
 * `e` tag names, so one filter for both kinds finds every answer. The
 * uppercase `E`/`A`/`I` scope tags are not indexed for our purposes, so a
 * comment scoped to an address rather than an event is simply not found;
 * `directReplies` then decides what is really a direct answer.
 */
async function queryRelays(postId: string): Promise<NostrEvent[]> {
  const urls = useRelays().readRelays();
  if (urls.length === 0) return [];
  const filter = { kinds: [1, 1111], "#e": [postId] };
  const settled = await Promise.allSettled(
    urls.map(async (url) => {
      const result = await getConnection(url).query(filter, 4000);
      return result.failed ? [] : result.events;
    }),
  );
  const seen = new Set<string>();
  const out: NostrEvent[] = [];
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const event of result.value) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      out.push(event);
    }
  }
  return out;
}

/** Starts resolving the answers to a post, unless that was already done. */
export async function loadReplies(postId: string): Promise<void> {
  if (postId === "" || asked.has(postId)) return;
  asked.add(postId);
  setLoading(true);
  let found: NostrEvent[] = [];
  try {
    found = await queryRelays(postId);
  } catch {
    // A relay that rejects leaves the list empty, which is what a post with
    // no answers looks like anyway.
    found = [];
  }
  rememberEvents(found);
  const answers = directReplies(found, postId);
  setReplies((prev) => {
    const next = new Map(prev);
    next.set(postId, answers);
    return next;
  });
  setLoading(false);
  setSearched(true);
}

/** The direct answers to a post, oldest first. Empty until they arrive. */
export function useReplies(postId: string): {
  events: () => NostrEvent[];
  loading: () => boolean;
  /** True once a search finished, so "no replies" can be said plainly. */
  searched: () => boolean;
} {
  return {
    events: () => replies().get(postId) ?? [],
    loading,
    searched,
  };
}

/**
 * Adds an answer the reader just wrote, so the form shows it at once
 * instead of waiting for a relay to hand it back. It joins the list in
 * conversation order, and the post counts as searched because the answer
 * already exists.
 */
export function addReply(event: NostrEvent): void {
  const postId = replyParent(event) ?? commentReplyParent(event);
  if (postId === null) return;
  rememberEvents([event]);
  setReplies((prev) => {
    const next = new Map(prev);
    next.set(
      postId,
      directReplies([...(next.get(postId) ?? []), event], postId),
    );
    return next;
  });
  setSearched(true);
}

/** Drops every cached answer, e.g. after a relay set change. */
export function resetReplies(): void {
  setReplies(new Map());
  setSearched(false);
  asked.clear();
}
