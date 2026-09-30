import {
  compareEvents,
  type Filter,
  type NostrEvent,
} from "dacci-nostr-nips";
import { createEffect, createSignal, onCleanup } from "solid-js";
import type { LiveSubscription } from "dacci-nostr-ws";
import { rememberEvents } from "./event-cache.js";
import { getConnection } from "./nostr.js";
import { useFeed, useRelays } from "./relays.js";

const MAX_BUFFERED = 200;

const [buffered, setBuffered] = createSignal<NostrEvent[]>([]);
const [liveRelays, setLiveRelays] = createSignal(0);

export function useLiveFeed() {
  return { buffered, liveRelays };
}

/**
 * Buffers live arrivals per relay instead of mutating the rendered list.
 * The UI shows a "new posts" affordance and flushes on click, which keeps
 * scroll position stable. Call inside a reactive root; the returned
 * function is a manual teardown, but cleanup is registered automatically.
 */
export function startLiveFeed(): () => void {
  const { relayUrls, relayVersion } = useRelays();
  const { feedAuthors } = useFeed();
  const subs: LiveSubscription[] = [];

  function teardown(): void {
    while (subs.length > 0) subs.pop()?.unsubscribe();
    setLiveRelays(0);
  }

  createEffect(() => {
    // Re-subscribe whenever the relay set or feed filter changes.
    relayVersion();
    feedAuthors();
    teardown();
    const authors = feedAuthors() ?? undefined;
    // `since` keeps the relay from replaying stored history: a live
    // subscription without it re-sends everything the relay has.
    const since = Math.floor(Date.now() / 1000);
    const filter: Filter =
      authors === undefined
        ? { kinds: [1], since }
        : { kinds: [1], authors, since };
    for (const url of relayUrls()) {
      subs.push(
        getConnection(url).subscribe(filter, (event) => {
          // Some relays replay stored events despite `since`; those are
          // already covered by pagination, so drop them here.
          if (event.created_at < since) return;
          rememberEvents([event]);
          setBuffered((prev) => {
            if (prev.some((existing) => existing.id === event.id)) return prev;
            return [...prev, event].sort(compareEvents).slice(0, MAX_BUFFERED);
          });
        }),
      );
    }
    setLiveRelays(subs.length);
    onCleanup(teardown);
  });

  return teardown;
}

/** Drop buffered events once they are merged into the rendered list. */
export function clearBuffered(): void {
  setBuffered([]);
}
