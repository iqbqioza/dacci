import {
  compareEvents,
  type Filter,
  type NostrEvent,
} from "dacci-nostr-nips";
import { createSignal } from "solid-js";
import type { LiveSubscription } from "dacci-nostr-ws";
import { rememberEvents } from "./event-cache.js";
import { getConnection } from "./nostr.js";

const MAX_BUFFERED = 200;

// Live events never touch a rendered list. They are buffered per purpose
// and only merged when the matching view asks for it, so switching pages
// does not interrupt reception.
const [feedBuffer, setFeedBuffer] = createSignal<NostrEvent[]>([]);
const [notificationBuffer, setNotificationBuffer] = createSignal<NostrEvent[]>(
  [],
);
const [liveRelays, setLiveRelays] = createSignal(0);
const [notificationRelays, setNotificationRelays] = createSignal(0);

export function useFeedLive() {
  return { buffered: feedBuffer, liveRelays };
}

export function useNotificationLive() {
  return { buffered: notificationBuffer, liveRelays: notificationRelays };
}

export function clearFeedBuffer(): void {
  setFeedBuffer([]);
}

export function clearNotificationBuffer(): void {
  setNotificationBuffer([]);
}

function push(buffer: (updater: (prev: NostrEvent[]) => NostrEvent[]) => void) {
  return (event: NostrEvent): void => {
    rememberEvents([event]);
    buffer((prev) => {
      if (prev.some((existing) => existing.id === event.id)) return prev;
      return [...prev, event].sort(compareEvents).slice(0, MAX_BUFFERED);
    });
  };
}

export interface LiveFeedDeps {
  /** Relays that may be queried; a write-only relay is never subscribed. */
  readRelays: () => string[];
  /** Follows plus self while logged in; null means the global feed. */
  feedAuthors: () => string[] | null;
  /** Own pubkey while logged in; undefined means no notifications. */
  selfPubkey: () => string | undefined;
}

/**
 * Opens (and keeps) one live subscription per relay for the home feed and,
 * when signed in, for notifications. Lives at app level so navigation
 * between pages does not drop the streams.
 */
export function startLiveFeeds(deps: LiveFeedDeps): () => void {
  const subs: LiveSubscription[] = [];

  const build = (): void => {
    for (const sub of subs) sub.unsubscribe();
    subs.length = 0;
    setFeedBuffer([]);
    setNotificationBuffer([]);

    const authors = deps.feedAuthors() ?? undefined;
    const self = deps.selfPubkey();

    const readable = deps.readRelays();
    for (const url of readable) {
      const connection = getConnection(url);
      // `since` keeps the relay from replaying stored history.
      const feedFilter: Filter =
        authors === undefined
          ? { kinds: [1], since: Math.floor(Date.now() / 1000) }
          : { kinds: [1], authors, since: Math.floor(Date.now() / 1000) };
      subs.push(connection.subscribe(feedFilter, push(setFeedBuffer)));

      if (self !== undefined) {
        subs.push(
          connection.subscribe(
            {
              kinds: [1, 6, 7],
              "#p": [self],
              since: Math.floor(Date.now() / 1000),
            },
            push(setNotificationBuffer),
          ),
        );
      }
    }
    setLiveRelays(subs.length);
    setNotificationRelays(subs.length - readable.length);
  };

  build();

  return () => {
    for (const sub of subs) sub.unsubscribe();
    subs.length = 0;
    setLiveRelays(0);
    setNotificationRelays(0);
  };
}

/** Keep the stream count honest for the debug panel. */
export function setNotificationRelayCount(count: number): void {
  setNotificationRelays(count);
}
