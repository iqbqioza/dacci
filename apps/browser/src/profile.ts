import type { Filter, NostrEvent } from "dacci-nostr-nips";
import { ProfileStore, type Profile } from "dacci-nostr-profile";
import { createSignal } from "solid-js";
import { getConnection } from "./nostr.js";
import { useRelays } from "./relays.js";

/** Bumped on every cache change so views re-read the store. */
const [version, setVersion] = createSignal(0);

const store = new ProfileStore(
  async (authors: string[]): Promise<NostrEvent[]> => {
    const urls = useRelays().relayUrls();
    if (urls.length === 0) return [];
    // One REQ for the whole batch; relays answer kind 0 newest-first.
    const filter: Filter = {
      kinds: [0],
      authors,
      limit: authors.length,
    };
    const settled = await Promise.allSettled(
      urls.map(async (url) => {
        const result = await getConnection(url).query(filter, 4000);
        return result.failed ? [] : result.events;
      }),
    );
    return settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  },
  { onChange: () => setVersion((v) => v + 1) },
);

/** Subscribes the caller to the cache and returns the current entry. */
export function useProfile(pubkey: string): {
  profile: Profile | null;
  loading: boolean;
} {
  version();
  return { profile: store.peek(pubkey), loading: store.isLoading(pubkey) };
}

/**
 * Queue unknown users. Already loaded and in-flight users are skipped by
 * the store, and failures land on its retry queue.
 */
export function requestProfiles(pubkeys: Iterable<string>): void {
  store.request(pubkeys);
}

/** Drops the cache, e.g. after a relay set change. */
export function resetProfiles(): void {
  store.clear();
  setVersion((v) => v + 1);
}
