import type { NostrEvent } from "dacci-nostr-nips";
import { compareEvents } from "dacci-nostr-nips";
import { createSignal } from "solid-js";
import { rememberEvents } from "./event-cache.js";
import { postsForTab, type FeedTab } from "./feed-tabs.js";
import { planFlush } from "./flush.js";
import { clearFeedBuffer, useFeedLive } from "./live.js";
import { isMutedAuthor } from "./muted.js";
import { createHomeTimeline } from "./nostr.js";
import { useFeed, useRelays } from "./relays.js";
import { preservingViewport } from "./viewport.js";

/**
 * Home feed state lives at module level, not inside the view, so navigating
 * away and back shows the same list instantly instead of showing
 * "読み込み中" and refetching. Only a real change (login, logout, relay
 * set, follow list) resets it.
 */
const [all, setAll] = createSignal<NostrEvent[]>([]);
const [tab, setTab] = createSignal<FeedTab>("notes");
const [loading, setLoading] = createSignal(true);
const [failed, setFailed] = createSignal(false);
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
let headerRef: HTMLDivElement | undefined;
let wasBarVisible = false;
let wasLoadMoreVisible = false;

function relayUrlsValue(): string[] {
  // The timeline only ever reads, so write-only relays stay out of it.
  return useRelays().readRelays();
}

function feedAuthorsValue(): string[] | undefined {
  return useFeed().feedAuthors() ?? undefined;
}

/**
 * The tab is a view over the loaded list, not a second query: no relay can
 * filter "has no e tag", so the home feed asks for kind 1 and NIP-22 comments
 * together and the split happens here.
 *
 * The posts the home timeline shows: the tab's split, minus anyone the reader
 * has muted.
 *
 * Muted authors are dropped here, and only here. NIP-51 scopes a mute to
 * feeds, so this is the home timeline and nothing else: a reader who opens a
 * profile or a post on purpose is not being shown something they did not ask to
 * avoid.
 */
export function homePostsFor(
  events: NostrEvent[],
  tab: FeedTab,
  /** Asked per author, because the list behind it can still be read. */
  isMuted: (pubkey: string) => boolean,
): NostrEvent[] {
  return postsForTab(events, tab).filter((event) => !isMuted(event.pubkey));
}

function visible(): NostrEvent[] {
  return homePostsFor(all(), tab(), isMutedAuthor);
}

/** Switches tab without touching the network: the list is already there. */
export function selectHomeTab(next: FeedTab): void {
  setTab(next);
}

/**
 * The pinned tab row and bar together, as one element. The viewport anchor
 * probe has to start below it, or it would hold on a card hidden under the
 * pinned header and the reader would be scrolled to the wrong place.
 */
export function pinnedHeaderHeight(): number {
  return headerRef?.offsetHeight ?? 0;
}

export function useHomeFeed() {
  return {
    /** Only the posts the selected tab shows. */
    events: visible,
    /** Everything loaded, whatever the tab shows. */
    loadedCount: () => all().length,
    tab,
    loading,
    loadingMore,
    coverage,
    authRelays,
    pendingRelays,
    failed,
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
    setHeaderRef: (el: HTMLDivElement | undefined) => {
      headerRef = el;
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
    // Deduped and re-sorted, like the profile and notification feeds. This list
    // has two writers — the paginator and the live arrivals — and they do not
    // know about each other, so an event both of them hold would otherwise be
    // drawn twice. A page can also begin with a post newer than the last one of
    // the page before it, when a relay that was behind catches up, and appending
    // it as it comes would put a newer post under an older one.
    setAll((prev) => {
      const seen = new Set<string>();
      return [...prev, ...page.events]
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
  setAll([]);
  setCoverage("partial");
  setAuthRelays([]);
  setPendingRelays([]);
  setFailed(false);
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
  const plan = planFlush(useFeedLive().buffered(), all());
  preservingViewport(listRef, () => {
    // This function accounts for the bar removal itself.
    wasBarVisible = false;
    clearFeedBuffer();
    if (plan.added.length > 0) {
      setAll(plan.events);
    }
  }, pinnedHeaderHeight());
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
  // Only the bar's own height shifts the list: the tab row above it is
  // always present, so it moves no content when the bar appears.
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
  preservingViewport(listRef, () => undefined, pinnedHeaderHeight());
}
