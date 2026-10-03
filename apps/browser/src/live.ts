import {
  compareEvents,
  type Filter,
  type NostrEvent,
} from "dacci-nostr-nips";
import { createSignal } from "solid-js";
import type { LiveSubscription } from "dacci-nostr-ws";
import { rememberEvents } from "./event-cache.js";
import {
  HOME_KINDS,
  NOTIFICATION_KINDS,
  PROFILE_KINDS,
  getConnection,
} from "./nostr.js";
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
  if (pubkey === null) return;
  subscribeProfile(pubkey);
}

/**
 * Opens the profile stream on every relay that may be queried.
 *
 * One relay only used to carry it, so its outage — or a relay-set change,
 * which never re-pointed the stream at all — silently killed profile live
 * arrivals while the paginator went on paging every relay. The bar then never
 * appeared until the subject changed, and the reader only learned on reload.
 */
function subscribeProfile(pubkey: string): void {
  for (const url of readRelaysValue()) {
    profileSubs.push(
      getConnection(url).subscribe(
        {
          // The same kinds the profile's paginator asks for. A kind only this one
          // left out can never reach the reader: the paginator's `until` moves
          // backwards only, so a comment published after it was built would sit
          // off the end of the list until a reset.
          kinds: PROFILE_KINDS,
          authors: [pubkey],
          since: Math.floor(Date.now() / 1000),
        },
        push(setProfileBuffer),
      ),
    );
  }
}

/**
 * Re-points the profile stream after the relay set changed, keeping whatever
 * arrived. The rebuild used to drop the stream without opening a new one, and
 * clearing the buffer with it would break the same promise the bar makes as
 * discarding arrivals does — so the buffer stays.
 */
export function refreshProfileStream(): void {
  const subject = profileSubject();
  if (subject === null) return;
  for (const sub of profileSubs) sub.unsubscribe();
  profileSubs.length = 0;
  subscribeProfile(subject);
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

/** Whose arrivals the buffers hold, so a rebuild knows whether they survive. */
let liveIdentity: string | null = null;

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
    const authors = deps.feedAuthors() ?? undefined;
    const self = deps.selfPubkey();
    // Arrivals survive a rebuild for the same reader: adding a relay
    // re-opens every stream with `since: now`, so whatever arrived before the
    // rebuild would neither be re-delivered nor, if dropped here, ever reach
    // the list — and the bar that promised it vanishes with no insertion and
    // no notice. A different reader, or a different follow filter, gets empty
    // buffers instead: the old arrivals are somebody else's, or match a filter
    // that no longer holds.
    const identity = `${self ?? ""}|${JSON.stringify(deps.feedAuthors())}`;
    const sameReader = identity === liveIdentity;
    liveIdentity = identity;
    if (!sameReader) {
      setFeedBuffer([]);
      setNotificationBuffer([]);
    }

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
    // The profile stream belongs to whoever is on screen, not to the relay
    // set it was opened on. Rebuilding without it left the profile with no
    // stream after every relay change until the subject changed.
    refreshProfileStream();
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
