import type { NostrEvent } from "dacci-nostr-nips";
import { compareEvents } from "dacci-nostr-nips";
import type { TimelinePaginator } from "dacci-nostr-paginator";
import { createSignal } from "solid-js";
import { withoutDeleted } from "./deleted.js";
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
import { createPinnedBars } from "./pinned-bars.js";
import { preservingViewport } from "./viewport.js";

/**
 * Notification state lives at module level so navigating away and back
 * shows the same list instead of refetching, matching the home feed.
 */
const [events, setEvents] = createSignal<NostrEvent[]>([]);
const [loading, setLoading] = createSignal(false);
const [failed, setFailed] = createSignal(false);
const [loadingMore, setLoadingMore] = createSignal(false);
const [coverage, setCoverage] = createSignal("partial");
const [authRelays, setAuthRelays] = createSignal<string[]>([]);
const [pendingRelays, setPendingRelays] = createSignal<string[]>([]);
const [hasMore, setHasMore] = createSignal(false);

/**
 * The arrivals row and the load-more control, shared with the other two feeds.
 *
 * This view has a pinned header too — the page bar and the arrivals row share one
 * sticky container — so the list is pushed down when the row appears and when the
 * load-more control comes or goes, exactly as in the other two. It had no
 * correction for either, and its flush anchored at the top of the page rather
 * than below the pinned header, which is the offset that decides which card the
 * reader is held on.
 */
const bars = createPinnedBars();

/**
 * Absorbs the arrivals row appearing, and the load-more control coming or going.
 *
 * The caller reads the signals outside `untrack`, so this is the effect's own
 * work rather than its trigger.
 */
export function noteBarVisibility(visible: boolean): void {
  bars.noteBarVisibility(visible);
}

export function noteLoadMoreVisibility(shown: boolean): void {
  bars.noteLoadMoreVisibility(shown);
}
// Guard for late async completions from a discarded generation.
let generation = 0;
let loadedFor: string | null = null;
/**
 * The paginator that holds where the next page starts.
 *
 * It has to outlive a page, like the home and profile feeds' paginators do. A
 * fresh one begins again at the newest notification, so "load more" would ask
 * for the first page again, have every event deduped away, and leave the reader
 * unable to reach anything older than their first page.
 */
let paginator: TimelinePaginator | null = null;

export function useNotifications() {
  return {
    /** What the reader has not deleted, which is not everything that loaded. */
    events: () => withoutDeleted(events()),
    loading,
    loadingMore,
    coverage,
    authRelays,
    pendingRelays,
    failed,
    hasMore,
    loadedFor,
    setListRef: bars.listRef,
    setBarRef: bars.barRef,
    setHeaderRef: bars.headerRef,
  };
}

async function loadPage(reset: boolean): Promise<void> {
  const pubkey = loadedFor;
  if (pubkey === null) return;
  const active = paginator ?? createNotificationTimeline(useRelays().readRelays(), pubkey);
  paginator = active;
  const gen = generation;
  if (reset) setLoading(true);
  else setLoadingMore(true);
  try {
    const page = await active.loadNextPage();
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
    setFailed(page.events.length === 0 && page.failedRelays.length > 0);
    setHasMore(active.hasMore());
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
  // The old paginator's cursors belong to a list that no longer exists, and a
  // stale page still in flight must not be able to move them.
  paginator = null;
  setEvents([]);
  setCoverage("partial");
  setAuthRelays([]);
  setPendingRelays([]);
  setFailed(false);
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
  const self = loadedFor;
  // The same guard the paginated path applies. A reader's own post carries a
  // `p` tag naming them whenever they reply to themselves, repost themselves or
  // answer themselves, and the relay indexes that like any other: without this
  // their own post arrives as a notification about themselves.
  const arriving =
    self === null
      ? []
      : useNotificationLive()
          .buffered()
          .filter((event) => isNotification(event, self));
  const plan = planFlush(arriving, events());
  preservingViewport(
    bars.listElement(),
    () => {
      // This function accounts for the row's own removal, alongside the prepend.
      bars.barRemoved();
      clearNotificationBuffer();
      if (plan.added.length > 0) setEvents(plan.events);
    },
    // Below the pinned header, which is the offset that says which card the
    // reader is actually looking at. Zero anchors to whatever is under the page
    // bar instead.
    bars.headerHeight(),
  );
}

export type { TimelineFilter };
