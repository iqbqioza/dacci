import {
  CONTACTS_KIND,
  parseContacts,
  type NostrEvent,
} from "dacci-nostr-nips";
import { createSignal } from "solid-js";
import { getConnection } from "./nostr.js";
import { useRelays } from "./relays.js";

/**
 * How many people each profile follows, from the subject's NIP-02 contact
 * list. Follower counts need NIP-45 counting relays and are not reliable
 * enough to show, so they are left out rather than guessed.
 */
const [counts, setCounts] = createSignal<Record<string, number>>({});
const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set());

/** Bumped when the relay set is dropped, so a round still out goes stale. */
let readGeneration = 0;

const METADATA_TIMEOUT_MS = 4000;

/** Follow count, or null while unknown or still loading. */
export function useFollowCount(pubkey: string): () => number | null {
  requestFollowCount(pubkey);
  return () => counts()[pubkey] ?? null;
}

/** Queues a subject once; a loaded or queued profile is never re-asked. */
export function requestFollowCount(pubkey: string): void {
  if (counts()[pubkey] !== undefined) return;
  if (pending().has(pubkey)) return;
  setPending((prev) => {
    const next: Set<string> = new Set<string>(prev);
    next.add(pubkey);
    return next;
  });
  void loadFollowCount(pubkey);
}

async function loadFollowCount(pubkey: string): Promise<void> {
  const generation = readGeneration;
  const filter = { kinds: [CONTACTS_KIND], authors: [pubkey], limit: 5 };
  const settled = await Promise.allSettled(
    useRelays()
      .readRelays()
      .map(async (url) => {
        const result = await Promise.race([
          getConnection(url).query(filter, METADATA_TIMEOUT_MS),
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), METADATA_TIMEOUT_MS),
          ),
        ]);
        // A relay that stayed silent, or that refused, is not a relay saying the
        // subject follows nobody. It is counted apart from an empty answer so
        // the two cannot be confused.
        if (result === null || result.failed) return null;
        return result.events;
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
  // Released whether or not anything answered. Leaving the subject queued would
  // keep `requestFollowCount` from ever asking again, so a single silent round
  // would cost the count for the rest of the session — and someone who really
  // follows nobody would stay unresolved too, since an empty answer is how
  // that is recorded.
  setPending((prev) => {
    const next: Set<string> = new Set(prev);
    next.delete(pubkey);
    return next;
  });
  // Nobody answered, so nothing is known. Leaving the count unknown says so,
  // and asking again is allowed now the subject is no longer queued.
  if (answered === 0) return;
  // A round left over from a relay set the reader has since dropped.
  if (generation !== readGeneration) return;
  events.sort((a, b) => b.created_at - a.created_at);
  // Asked and answered with nothing is an answer: the subject published no
  // contact list, which is exactly what "follows 0" says. Reading it as "no
  // events came back" left the row unresolved and the subject queued for good.
  const newest = events[0];
  const follows =
    newest === undefined ? [] : parseContacts(newest).filter((key) => key !== pubkey);
  setCounts((prev) => ({ ...prev, [pubkey]: follows.length }));
}

/** Dropped when the relay set changes, so a new relay can answer. */
export function resetFollowCounts(): void {
  readGeneration += 1;
  setCounts({});
  setPending(new Set<string>());
}
