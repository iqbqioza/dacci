import type { Filter, NostrEvent } from "dacci-nostr-nips";
import { DELETION_KIND, deletedEventIds } from "dacci-nostr-nips";
import { createSignal } from "solid-js";
import { getConnection } from "./nostr.js";
import { useRelays } from "./relays.js";

/**
 * The posts a NIP-09 deletion request has taken away.
 *
 * A deletion request removes nothing by itself. Relays that honour NIP-09 drop
 * the event from their store, but a client has already loaded what it showed,
 * and a relay that ignores NIP-09 will send the same post again on the next
 * query. So the request is kept here and every list the app renders is read
 * through it.
 *
 * The state is the reader's own deletions, which are their own business, and it
 * is not written to localStorage: a post deleted on one device should be gone
 * on every one, and the relays are where that is decided. It is rebuilt from
 * them on every login.
 */
const [deleted, setDeleted] = createSignal<ReadonlySet<string>>(new Set());
/**
 * Whose deletions these are, and a token for the read in flight.
 *
 * A deletion request is the reader's own, so this list belongs to one reader the
 * way the follow and mute lists do. Without that it never shrinks: one reader
 * deletes a post, signs out, and the next reader still cannot see it — for a
 * deletion they had nothing to do with and no way to undo.
 */
let owner: string | null = null;
/** Bumped per read, so a reply that settles after a reader change is dropped. */
let readGeneration = 0;

/** Whether a post has been deleted. */
export function isDeleted(id: string): boolean {
  return deleted().has(id);
}

/**
 * Takes posts away, which is what a published deletion request does here too.
 * The reader's own events are remembered by the activity store, which sends
 * the kind 5 that this list stands for.
 *
 * `signedAs` is the account whose deletion this is. The caller publishes first
 * and records afterwards, which is after a signing prompt and up to five seconds
 * of relay time — long enough for the reader to sign out. Recording then would
 * install the previous reader's deletions into the set that has just been
 * cleared for the next one, and their posts would silently vanish from it.
 *
 * A set nobody has claimed yet is not at risk: it is empty, and refusing the
 * write there would only stop a reader seeing their own deletion take effect.
 */
export function markDeleted(ids: Iterable<string>, signedAs?: string | null): void {
  if (signedAs !== undefined && owner !== null && signedAs !== owner) return;
  setDeleted((prev) => {
    const next = new Set(prev);
    let added = false;
    for (const id of ids) {
      if (next.has(id)) continue;
      next.add(id);
      added = true;
    }
    // Nothing changed, so the signal is left alone: a new Set would redraw
    // every feed for no reason.
    return added ? next : prev;
  });
}

/**
 * The events a list should show: the loaded ones minus the deleted. A view
 * that forgets this shows a post the reader deleted in another tab.
 */
export function withoutDeleted(events: NostrEvent[]): NostrEvent[] {
  const gone = deleted();
  if (gone.size === 0) return events;
  return events.filter((event) => !gone.has(event.id));
}

/** Whether a post is the reader's own, which is what a deletion is for. */
export function isOwn(event: NostrEvent, self: string | null): boolean {
  return self !== null && event.pubkey === self;
}

const SYNC_TIMEOUT_MS = 5000;
/** How many of the reader's own deletion requests to read back. */
const SYNC_LIMIT = 500;

/**
 * Reads the reader's own deletion requests back from the relays, so a post
 * deleted on one device is gone on this one too.
 *
 * This asks for kind 5 on its own rather than sharing the reader's other
 * events: those are queried for what the reader has *done* lately, and a
 * deletion from last year falls outside that window, which would put an old
 * deleted post back on screen.
 */
export async function syncDeleted(pubkey: string): Promise<void> {
  // A different reader has a different set of requests, and a read still
  // running belongs to the reader who started it.
  if (owner !== pubkey) {
    owner = pubkey;
    readGeneration += 1;
    setDeleted(new Set<string>());
  }
  const generation = readGeneration;
  const filter: Filter = { kinds: [DELETION_KIND], authors: [pubkey], limit: SYNC_LIMIT };
  const settled = await Promise.allSettled(
    useRelays()
      .readRelays()
      .map(async (url) => {
        const result = await Promise.race([
          getConnection(url).query(filter, SYNC_TIMEOUT_MS),
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), SYNC_TIMEOUT_MS),
          ),
        ]);
        // A relay that refused is not an answer, so it is kept apart from one
        // that replied with nothing.
        return result?.failed === true || result === null ? null : result.events;
      }),
  );
  const events: NostrEvent[] = [];
  let answered = 0;
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value !== null) {
      answered += 1;
      events.push(...result.value);
    }
  }
  // Nothing answered, so what is known stays known: a deletion read once is
  // not undone by a relay that is merely quiet now.
  if (answered === 0) return;
  // The reader changed while this was out, so the answer belongs to a list
  // nobody is looking at any more. Writing it would apply one reader's
  // deletions to the next reader's feeds.
  if (generation !== readGeneration) return;
  markDeleted(deletedEventIds(events));
}

/**
 * Drops the list, on a login change or a relay change, so it is read again for
 * whoever is reading now. A request still in flight is made stale so its answer
 * cannot land in the fresh list.
 */
export function resetDeleted(): void {
  owner = null;
  readGeneration += 1;
  setDeleted(new Set<string>());
}