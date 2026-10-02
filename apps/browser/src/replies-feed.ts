import type { NostrEvent } from "dacci-nostr-nips";
import { createSignal, type Setter } from "solid-js";
import { rememberEvents } from "./event-cache.js";
import { getConnection } from "./nostr.js";
import { commentReplyParent, directReplies, replyParent } from "./replies.js";
import { withoutDeleted } from "./deleted.js";
import { useRelays } from "./relays.js";

/**
 * The direct answers to one post, kept per post id at module level so
 * moving between two posts and back does not refetch.
 */
const [replies, setReplies] = createSignal<Map<string, NostrEvent[]>>(
  new Map(),
);

/**
 * Whether a round is out, and whether one has ever finished, per post.
 *
 * Both were single flags for the whole app, which read as if they described the
 * thread on screen and did not: open one thread successfully and every later
 * post claimed to have been searched, so a post nobody had asked about rendered
 * as "this post has no replies yet" — a conclusion about a post the client had
 * never queried. And a second post opened while the first was still in flight
 * cleared the flag for the first, so a half-loaded thread read as complete.
 */
const [loadingFor, setLoadingFor] = createSignal<Map<string, boolean>>(
  new Map(),
);
const [searchedFor, setSearchedFor] = createSignal<Map<string, boolean>>(
  new Map(),
);

/** Writes one post's flag without disturbing another's. */
function flag(
  set: Setter<Map<string, boolean>>,
  postId: string,
  value: boolean,
): void {
  set((prev) => {
    const next = new Map(prev);
    next.set(postId, value);
    return next;
  });
}

/** Posts already asked about, so a revisit never queries again. */
const asked = new Set<string>();
/** Bumped when the relay set is dropped, so a round still out goes stale. */
let generation = 0;

/**
 * Asks the read relays for anything pointing at `postId`.
 *
 * A relay indexes a NIP-10 reply and a NIP-22 comment under the event the
 * `e` tag names, so one filter for both kinds finds every answer. The
 * uppercase `E`/`A`/`I` scope tags are not indexed for our purposes, so a
 * comment scoped to an address rather than an event is simply not found;
 * `directReplies` then decides what is really a direct answer.
 */
async function queryRelays(
  postId: string,
): Promise<{ events: NostrEvent[]; answered: number }> {
  const urls = useRelays().readRelays();
  if (urls.length === 0) return { events: [], answered: 0 };
  const filter = { kinds: [1, 1111], "#e": [postId] };
  const settled = await Promise.allSettled(
    urls.map(async (url) => {
      const result = await getConnection(url).query(filter, 4000);
      // A relay that refused is counted apart from one that answered, so
      // "nobody answered" and "nobody has any" cannot be confused.
      return result.failed ? null : result.events;
    }),
  );
  const seen = new Set<string>();
  const out: NostrEvent[] = [];
  let answered = 0;
  for (const result of settled) {
    if (result.status !== "fulfilled" || result.value === null) continue;
    answered += 1;
    for (const event of result.value) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      out.push(event);
    }
  }
  return { events: out, answered };
}

/** Starts resolving the answers to a post, unless that was already done. */
export async function loadReplies(postId: string): Promise<void> {
  if (postId === "" || asked.has(postId)) return;
  const gen = generation;
  asked.add(postId);
  flag(setLoadingFor, postId, true);
  let found: NostrEvent[] = [];
  let answered = 0;
  try {
    ({ events: found, answered } = await queryRelays(postId));
  } catch {
    // A relay that rejects leaves nothing found, which is what a post with no
    // answers looks like anyway.
    found = [];
  }
  // The reader changed relays while this was out. The answer belongs to a list
  // nobody is looking at now, and `asked` no longer holds the id, so writing it
  // would fill the fresh map from relays that have just been dropped and leave
  // the new relay set never asked about this post.
  if (gen !== generation) return;
  if (answered === 0) {
    // Nobody answered, so nothing is known — which is not the same as the post
    // having no answers. Leaving the id in `asked` would settle that here and
    // for good: the thread would read "no replies" for the rest of the session
    // with no way to ask again. It is released instead, and `searched` stays
    // false so the reader is not shown a conclusion nobody reached.
    asked.delete(postId);
    flag(setLoadingFor, postId, false);
    return;
  }
  rememberEvents(found);
  const answers = directReplies(found, postId);
  setReplies((prev) => {
    const next = new Map(prev);
    // A reply the reader has just published is not in a relay's answer yet, and
    // a NIP-07 prompt makes that overlap likely. Replacing the list with what
    // the relays said would make their own reply vanish from the thread it was
    // sent in, with nothing to fetch it back.
    const kept = (prev.get(postId) ?? []).filter(
      (event) => !answers.some((answer) => answer.id === event.id),
    );
    next.set(postId, directReplies([...answers, ...kept], postId));
    return next;
  });
  flag(setLoadingFor, postId, false);
  flag(setSearchedFor, postId, true);
}

/** The direct answers to a post, oldest first. Empty until they arrive. */
export function useReplies(postId: string): {
  events: () => NostrEvent[];
  loading: () => boolean;
  /** True once a search finished, so "no replies" can be said plainly. */
  searched: () => boolean;
} {
  return {
    // An answer the reader deleted is not an answer any more, so the thread is
    // read through the deletions rather than straight from the cache.
    events: () => withoutDeleted(replies().get(postId) ?? []),
    loading: () => loadingFor().get(postId) ?? false,
    searched: () => searchedFor().get(postId) ?? false,
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
  flag(setSearchedFor, postId, true);
}

/** Drops every cached answer, e.g. after a relay set change. */
export function resetReplies(): void {
  // A read in flight belongs to the relay set that asked for it, so the new one
  // makes that answer stale rather than current.
  generation += 1;
  setReplies(new Map());
  setSearchedFor(new Map());
  setLoadingFor(new Map());
  asked.clear();
}
