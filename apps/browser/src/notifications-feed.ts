import type { NostrEvent } from "dacci-nostr-nips";
import { compareEvents } from "dacci-nostr-nips";
import { createSignal } from "solid-js";
import { rememberEvents } from "./event-cache.js";
import { planFlush } from "./flush.js";
import {
  clearNotificationBuffer,
  useNotificationLive,
} from "./live.js";
import {
  createNotificationTimeline,
  isNotification,
  type TimelineFilter,
} from "./nostr.js";
import { useRelays } from "./relays.js";
import { preservingViewport } from "./viewport.js";

/**
 * Notification state lives at module level so navigating away and back
 * shows the same list instead of refetching, matching the home feed.
 */
const [events, setEvents] = createSignal<NostrEvent[]>([]);
const [loading, setLoading] = createSignal(false);
const [loadingMore, setLoadingMore] = createSignal(false);
const [coverage, setCoverage] = createSignal("partial");
const [authRelays, setAuthRelays] = createSignal<string[]>([]);
const [pendingRelays, setPendingRelays] = createSignal<string[]>([]);
const [hasMore, setHasMore] = createSignal(false);
// Guard for late async completions from a discarded generation.
let generation = 0;
let listRef: HTMLDivElement | undefined;
let loadedFor: string | null = null;

export function useNotifications() {
  return {
    events,
    loading,
    loadingMore,
    coverage,
    authRelays,
    pendingRelays,
    hasMore,
    loadedFor,
    setListRef: (el: HTMLDivElement | undefined) => {
      listRef = el;
    },
  };
}

async function loadPage(reset: boolean): Promise<void> {
  const pubkey = loadedFor;
  if (pubkey === null) return;
  const paginator = createNotificationTimeline(useRelays().relayUrls(), pubkey);
  const gen = generation;
  if (reset) setLoading(true);
  else setLoadingMore(true);
  try {
    const page = await paginator.loadNextPage();
    if (gen !== generation) return;
    // Relays only answer what they indexed, so the union is verified here:
    // addressed to this pubkey, and never the user's own event.
    const accepted = page.events.filter((event) =>
      isNotification(event, pubkey),
    );
    rememberEvents(accepted);
    setEvents((prev) => {
      const merged = [...prev, ...accepted];
      const seen = new Set<string>();
      return merged
        .filter((event) => {
          if (seen.has(event.id)) return false;
          seen.add(event.id);
          return true;
        })
        .sort(compareEvents);
    });
    setCoverage(page.coverage);
    setAuthRelays(page.authRequiredRelays);
    setPendingRelays(page.pendingRelays);
    setHasMore(paginator.hasMore());
  } finally {
    if (gen === generation) {
      setLoading(false);
      setLoadingMore(false);
    }
  }
}

/** Loads the first page for a pubkey, or does nothing when already loaded. */
export function ensureNotifications(pubkey: string | null): void {
  if (pubkey === null) {
    resetNotifications();
    return;
  }
  if (loadedFor === pubkey) return;
  resetNotifications();
  loadedFor = pubkey;
  void loadPage(true);
}

export function resetNotifications(): void {
  generation += 1;
  loadedFor = null;
  setEvents([]);
  setCoverage("partial");
  setAuthRelays([]);
  setPendingRelays([]);
  setHasMore(false);
  setLoading(false);
  setLoadingMore(false);
}

export function loadMoreNotifications(): void {
  if (loading() || loadingMore() || !hasMore()) return;
  void loadPage(false);
}

/** Inserts buffered live notifications above the current first one. */
export function flushNotificationArrivals(): void {
  const plan = planFlush(useNotificationLive().buffered(), events());
  preservingViewport(listRef, () => {
    clearNotificationBuffer();
    if (plan.added.length > 0) setEvents(plan.events);
  });
}

export type { TimelineFilter };
