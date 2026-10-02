import type { Filter, NostrEvent } from "dacci-nostr-nips";
import { ProfileStore, type Profile } from "dacci-nostr-profile";
import { createSignal } from "solid-js";
import { isSignedBy } from "./authored.js";
import { getConnection } from "./nostr.js";
import { useRelays } from "./relays.js";

/** Bumped on every cache change so views re-read the store. */
const [version, setVersion] = createSignal(0);

const store = new ProfileStore(
  async (authors: string[]): Promise<NostrEvent[]> => {
    // Metadata is a read, so only read-capable relays are asked.
    const urls = useRelays().readRelays();
    // No relay can answer, so the store is told the question is open rather
    // than answered with nothing. A reader whose relays are all write-only
    // would otherwise be recorded as having no profile, and the editor would
    // then publish an empty one over the real thing.
    if (urls.length === 0) throw new Error("no relay can be read from");
    // One REQ for the whole batch; relays answer kind 0 newest-first.
    const filter: Filter = {
      kinds: [0],
      authors,
      limit: authors.length,
    };
    // A relay that refused still settles its promise, so the relays that
    // answered are counted by what they said, not by whether their promise
    // resolved. Counting the latter would make a round where every relay
    // failed look like a round where every relay said there is no profile,
    // which is the one mistake this whole distinction exists to prevent.
    let answered = 0;
    const settled = await Promise.allSettled(
      urls.map(async (url) => {
        const result = await getConnection(url).query(filter, 4000);
        if (result.failed) return [];
        answered += 1;
        return result.events;
      }),
    );
    // Every relay refused or timed out. Throwing keeps the lookup open, which
    // is the difference between "no profile" and "we do not know yet".
    if (answered === 0) throw new Error("no relay answered");
    const events = settled.flatMap((r) =>
      r.status === "fulfilled" ? r.value : ([] as NostrEvent[]),
    );

    // Metadata is acted on rather than merely read: a forged one puts a name and
    // a face under a real person's key, and its `picture` is fetched from
    // wherever the forger chose — so the reader's browser is sent to an address
    // of somebody else's picking, attributed to somebody they follow. Only an
    // event the author signed may stand in for the author.
    const signed: NostrEvent[] = [];
    const forged = new Set<string>();
    for (const event of events) {
      if (isSignedBy(event, event.pubkey)) signed.push(event);
      else forged.add(event.pubkey);
    }

    // An author nobody signed for is not an author without a profile, and this
    // store cannot tell the two apart: an empty answer is recorded as "asked, and
    // there is nothing" and never asked again, and the editor would then publish
    // an empty profile over the real one. Throwing keeps the question open
    // instead. The whole batch is re-asked rather than just the author, which
    // costs a little and is bounded by the store's own attempts.
    for (const pubkey of authors) {
      if (forged.has(pubkey) && !signed.some((event) => event.pubkey === pubkey)) {
        throw new Error("a relay answered with metadata nobody signed");
      }
    }
    return signed;
  },
  { onChange: () => setVersion((v) => v + 1) },
);

/** Subscribes the caller to the cache and returns the current entry. */
export function useProfile(pubkey: string): {
  profile: Profile | null;
  loading: boolean;
  /**
   * Whether this author's profile has been settled. A null profile that is
   * resolved means the author has none; a null profile that is not resolved
   * means it has not arrived, and writing on top of that would replace a real
   * profile with an empty one.
   */
  resolved: boolean;
} {
  version();
  return {
    profile: store.peek(pubkey),
    loading: store.isLoading(pubkey),
    resolved: store.resolved(pubkey),
  };
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

/**
 * Adopts a profile this client just published. The store ignores an author it
 * already knows, which would leave the header showing the profile the reader
 * has just replaced.
 */
export function applyProfile(event: NostrEvent): void {
  store.put(event);
}
