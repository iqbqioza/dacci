import type { NostrEvent } from "dacci-nostr-nips";
import { compareEvents, isHex64 } from "dacci-nostr-nips";
import { createSignal } from "solid-js";
import { rememberEvents } from "./event-cache.js";
import { postsForTab, type FeedTab } from "./feed-tabs.js";
import { planFlush } from "./flush.js";
import { clearProfileBuffer, useProfileLive } from "./live.js";
import { createTimeline, PROFILE_KINDS } from "./nostr.js";
import { useRelays } from "./relays.js";
import { createPinnedBars } from "./pinned-bars.js";
import { preservingViewport } from "./viewport.js";

/**
 * Profile feed state lives at module level like the other feeds, so
 * switching subjects or tabs never refetches what is already loaded. The
 * paginator holds every kind 1 post by the subject; the tabs are a view
 * over that list, because no relay can filter "has no e tag".
 */
const [all, setAll] = createSignal<NostrEvent[]>([]);
const [subject, setSubject] = createSignal<string | null>(null);
const [tab, setTab] = createSignal<FeedTab>("notes");
const [loading, setLoading] = createSignal(false);
const [failed, setFailed] = createSignal(false);
const [loadingMore, setLoadingMore] = createSignal(false);
const [coverage, setCoverage] = createSignal("partial");
const [authRelays, setAuthRelays] = createSignal<string[]>([]);
const [pendingRelays, setPendingRelays] = createSignal<string[]>([]);
const [hasMore, setHasMore] = createSignal(true);

/** The arrivals row and the load-more control, shared with the home timeline. */
const bars = createPinnedBars();

let paginator = createTimeline(useRelays().readRelays(), {
  kinds: PROFILE_KINDS,
});
let generation = 0;

/**
 * The tab is a view over the loaded list, not a separate query: no relay
 * can filter "has no e tag", so both tabs read the same events. Comments
 * (NIP-22 kind 1111) only ever belong to the replies tab.
 */
function visible(): NostrEvent[] {
  return postsForTab(all(), tab());
}

export function useProfileFeed() {
  return {
    subject,
    tab,
    events: visible,
    /** Everything loaded for the subject, whatever the tab shows. */
    loadedCount: () => all().length,
    loading,
    loadingMore,
    coverage,
    authRelays,
    pendingRelays,
    failed,
    hasMore,
    setListRef: bars.listRef,
    setBarRef: bars.barRef,
    setHeaderRef: bars.headerRef,
  };
}

/**
 * Absorbs the arrivals row appearing, and the load-more control coming or going.
 *
 * The profile feed had neither, and a profile is where a reader is most likely
 * to be scrolled: they arrived from a link to somebody they already follow. Every
 * new post from that person pushed the list down by the row's height with nothing
 * to hold it, so the post they were reading moved on every arrival.
 */
export function noteBarVisibility(visible: boolean): void {
  bars.noteBarVisibility(visible);
}

/** Switches tab without touching the network: the list is already there. */
export function selectProfileTab(next: FeedTab): void {
  setTab(next);
}

/**
 * Points the feed at a subject, loading it the first time it is seen. The
 * paginator and the list are replaced together, so a page in flight for the
 * previous subject can never land in the new one.
 */
export function openProfile(pubkey: string | null): void {
  if (pubkey !== null && !isHex64(pubkey)) {
    setSubject(null);
    rebuild(null);
    return;
  }
  // A subject that is already loaded is reused, so returning to a profile
  // is instant and never refetches.
  if (subject() === pubkey) return;
  setSubject(pubkey);
  rebuild(pubkey);
  if (pubkey !== null) void loadMoreProfile();
}

/** New paginator for a subject, and an empty list to fill. */
function rebuild(pubkey: string | null): void {
  paginator = createTimeline(useRelays().readRelays(), {
    // Notes and NIP-22 comments in one query; the tabs split them.
    kinds: PROFILE_KINDS,
    ...(pubkey === null ? {} : { authors: [pubkey] }),
  });
  // Any page still in flight belongs to the previous paginator.
  generation += 1;
  setAll([]);
  setCoverage("partial");
  setAuthRelays([]);
  setPendingRelays([]);
  setFailed(false);
  setHasMore(true);
  setLoading(false);
  setLoadingMore(false);
}

export async function loadMoreProfile(): Promise<void> {
  const active = paginator;
  const gen = generation;
  if (loading() || loadingMore() || !hasMore()) return;
  if (all().length === 0) setLoading(true);
  else setLoadingMore(true);
  try {
    const page = await active.loadNextPage();
    // Both checks matter: the generation covers a reset, the identity
    // check covers a paginator swap that reused the same generation.
    if (gen !== generation || active !== paginator) return;
    rememberEvents(page.events);
    setAll((prev) => {
      const seen = new Set(prev.map((event) => event.id));
      const merged = [
        ...prev,
        ...page.events.filter((event) => !seen.has(event.id)),
      ];
      return merged.sort(compareEvents);
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

/** Rebuilds the paginator for the current subject, e.g. a relay change. */
export function resetProfileFeed(): void {
  const current = subject();
  rebuild(current);
  if (current !== null) void loadMoreProfile();
}

/** New posts by this subject, pinned above the list without moving it. */
export function flushProfileArrivals(): void {
  const plan = planFlush(useProfileLive().buffered(), all());
  preservingViewport(
    bars.listElement(),
    () => {
      // This function accounts for the row's own removal, alongside the prepend.
      bars.barRemoved();
      clearProfileBuffer();
      if (plan.added.length > 0) setAll(plan.events.sort(compareEvents));
    },
    bars.headerHeight(),
  );
}
