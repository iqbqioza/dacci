import {
  compareEvents,
  type Filter,
  type NostrEvent,
} from "dacci-nostr-nips";
import { createSignal } from "solid-js";
import type { LiveSubscription } from "dacci-nostr-ws";
import { rememberEvents } from "./event-cache.js";
import { HOME_KINDS, NOTIFICATION_KINDS, getConnection } from "./nostr.js";
import { useRelays } from "./relays.js";

const MAX_BUFFERED = 200;

// Live events never touch a rendered list. They are buffered per purpose
// and only merged when the matching view asks for it, so switching pages
// does not interrupt reception.
const [feedBuffer, setFeedBuffer] = createSignal<NostrEvent[]>([]);
const [notificationBuffer, setNotificationBuffer] = createSignal<NostrEvent[]>(
  [],
);
const [profileBuffer, setProfileBuffer] = createSignal<NostrEvent[]>([]);
/** The profile feed follows whoever the reader is looking at. */
const [profileSubject, setProfileSubject] = createSignal<string | null>(null);
const [liveRelays, setLiveRelays] = createSignal(0);
const [notificationRelays, setNotificationRelays] = createSignal(0);

export function useFeedLive() {
  return { buffered: feedBuffer, liveRelays };
}

export function useNotificationLive() {
  return { buffered: notificationBuffer, liveRelays: notificationRelays };
}

export function useProfileLive() {
  return { buffered: profileBuffer, subject: profileSubject };
}

export function clearFeedBuffer(): void {
  setFeedBuffer([]);
}

export function clearNotificationBuffer(): void {
  setNotificationBuffer([]);
}

export function clearProfileBuffer(): void {
  setProfileBuffer([]);
}

/**
 * Points the profile stream at a subject. The subscription is left in
 * place across navigation and only re-filtered when the subject changes,
 * so opening a profile is instant.
 */
export function watchProfileSubject(pubkey: string | null): void {
  if (profileSubject() === pubkey) return;
  setProfileSubject(pubkey);
  setProfileBuffer([]);
  for (const sub of profileSubs) sub.unsubscribe();
  profileSubs.length = 0;
  const [url] = readRelaysValue();
  if (pubkey === null || url === undefined) return;
  profileSubs.push(
    getConnection(url).subscribe(
      {
        kinds: [1],
        authors: [pubkey],
        since: Math.floor(Date.now() / 1000),
      },
      push(setProfileBuffer),
    ),
  );
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

/** Subscriptions that follow the profile page's subject. */
const profileSubs: LiveSubscription[] = [];

function readRelaysValue(): string[] {
  return useRelays().readRelays();
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
      // `since` keeps the relay from replaying stored history. The home feed
      // shows NIP-22 comments beside kind 1, so the stream carries both.
      const feedKinds = HOME_KINDS;
      const feedFilter: Filter =
        authors === undefined
          ? { kinds: feedKinds, since: Math.floor(Date.now() / 1000) }
          : { kinds: feedKinds, authors, since: Math.floor(Date.now() / 1000) };
      subs.push(connection.subscribe(feedFilter, push(setFeedBuffer)));

      if (self !== undefined) {
        subs.push(
          connection.subscribe(
            {
              // The same kinds the paginated list asks for. NIP-22 comments are
              // in it: a kind 1111 that addresses the reader has to reach the
              // live stream too, or the bar never tells them about it and only
              // a reload would.
              kinds: NOTIFICATION_KINDS,
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
    for (const sub of profileSubs) sub.unsubscribe();
    profileSubs.length = 0;
    setLiveRelays(0);
    setNotificationRelays(0);
  };
}

/** Keep the stream count honest for the debug panel. */
export function setNotificationRelayCount(count: number): void {
  setNotificationRelays(count);
}
