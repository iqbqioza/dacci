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
        return result?.failed === true ? [] : result?.events ?? [];
      }),
  );
  const events: NostrEvent[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") events.push(...result.value);
  }
  events.sort((a, b) => b.created_at - a.created_at);
  if (events.length === 0) return;
  const follows = parseContacts(events[0]).filter((key) => key !== pubkey);
  setCounts((prev) => ({ ...prev, [pubkey]: follows.length }));
  setPending((prev) => {
    const next: Set<string> = new Set(prev);
    next.delete(pubkey);
    return next;
  });
}

/** Dropped when the relay set changes, so a new relay can answer. */
export function resetFollowCounts(): void {
  setCounts({});
  setPending(new Set<string>());
}
