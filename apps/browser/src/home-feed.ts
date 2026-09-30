import type { NostrEvent } from "dacci-nostr-nips";
import { createSignal } from "solid-js";
import { rememberEvents } from "./event-cache.js";
import { planFlush } from "./flush.js";
import { clearFeedBuffer, useFeedLive } from "./live.js";
import { createHomeTimeline } from "./nostr.js";
import { useFeed, useRelays } from "./relays.js";
import { preservingViewport } from "./viewport.js";

/**
 * Home feed state lives at module level, not inside the view, so navigating
 * away and back shows the same list instantly instead of showing
 * "読み込み中" and refetching. Only a real change (login, logout, relay
 * set, follow list) resets it.
 */
const [events, setEvents] = createSignal<NostrEvent[]>([]);
const [loading, setLoading] = createSignal(true);
const [loadingMore, setLoadingMore] = createSignal(false);
const [coverage, setCoverage] = createSignal("partial");
const [authRelays, setAuthRelays] = createSignal<string[]>([]);
const [pendingRelays, setPendingRelays] = createSignal<string[]>([]);
const [hasMore, setHasMore] = createSignal(true);

// Guards late async completions from a discarded paginator generation.
let paginator = createHomeTimeline(relayUrlsValue(), feedAuthorsValue());
let generation = 0;
let listRef: HTMLDivElement | undefined;
let barRef: HTMLButtonElement | undefined;
let wasBarVisible = false;
let wasLoadMoreVisible = false;

function relayUrlsValue(): string[] {
  return useRelays().relayUrls();
}

function feedAuthorsValue(): string[] | undefined {
  return useFeed().feedAuthors() ?? undefined;
}

export function useHomeFeed() {
  return {
    events,
    loading,
    loadingMore,
    coverage,
    authRelays,
    pendingRelays,
    hasMore,
    barRef: () => barRef,
    listRef: () => listRef,
    setListRef: (el: HTMLDivElement | undefined) => {
      listRef = el;
    },
    setBarRef: (el: HTMLButtonElement | undefined) => {
      barRef = el;
      wasBarVisible = false;
    },
  };
}

export async function loadMoreHome(): Promise<void> {
  const active = paginator;
  const gen = generation;
  if (loadingMore() || !hasMore()) return;
  setLoadingMore(true);
  try {
    const page = await active.loadNextPage();
    if (gen !== generation) return;
    // Keep a cache so event deep links survive reloads.
    rememberEvents(page.events);
    setEvents((prev) => [...prev, ...page.events]);
    setCoverage(page.coverage);
    setAuthRelays(page.authRequiredRelays);
    setPendingRelays(page.pendingRelays);
    // NOTE: hasMore follows the paginator, not the page size, so a page
    // emptied by failures keeps retrying instead of looking finished.
    setHasMore(active.hasMore());
  } finally {
    if (gen === generation) {
      setLoading(false);
      setLoadingMore(false);
    }
  }
}

/** Rebuilds the timeline for a new relay set or feed filter. */
export function resetHomeFeed(): void {
  const next = createHomeTimeline(relayUrlsValue(), feedAuthorsValue());
  paginator = next;
  generation += 1;
  setEvents([]);
  setCoverage("partial");
  setAuthRelays([]);
  setPendingRelays([]);
  setHasMore(true);
  setLoading(true);
  setLoadingMore(false);
  void loadMoreHome();
}

/**
 * Pressing the bar inserts the new posts above the current first post and
 * pins the viewport, so the reader keeps looking at the same post instead
 * of being dropped on the newest one.
 */
export function flushNewArrivals(): void {
  const plan = planFlush(useFeedLive().buffered(), events());
  preservingViewport(listRef, () => {
    // This function accounts for the bar removal itself.
    wasBarVisible = false;
    clearFeedBuffer();
    if (plan.added.length > 0) {
      setEvents(plan.events);
    }
  });
}

/**
 * The bar only exists while there are new posts, so appearing pushes the
 * list down by one bar height. Undo that for a scrolled reader; at the top
 * the bar is what should be visible. Removal is corrected in
 * flushNewArrivals, together with the prepend.
 */
export function noteBarVisibility(visible: boolean): void {
  if (!visible || wasBarVisible) return;
  wasBarVisible = true;
  const height = barRef?.offsetHeight ?? 0;
  if (height <= 0 || window.scrollY <= 0) return;
  window.scrollBy({ top: height, behavior: "instant" });
}

/**
 * The load-more control is in the flow as well, so appearing (first page)
 * or disappearing (history exhausted) has to be absorbed too.
 */
export function noteLoadMoreVisibility(shown: boolean): void {
  if (shown === wasLoadMoreVisible) return;
  wasLoadMoreVisible = shown;
  preservingViewport(listRef, () => undefined);
}
