import type { NostrEvent } from "dacci-nostr-nips";
import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import { createTimeline } from "../nostr.js";
import { rememberEvents } from "../event-cache.js";
import { planFlush } from "../flush.js";
import { clearBuffered, startLiveFeed, useLiveFeed } from "../live.js";
import { useFeed, useRelays } from "../relays.js";
import { EventCard } from "./EventCard.jsx";

export function HomeTimeline(props: {
  onSelect: (event: NostrEvent) => void;
}) {
  const { relayUrls, relayVersion } = useRelays();
  const { feedAuthors } = useFeed();
  const { buffered } = useLiveFeed();
  // Scoped to the list so the viewport anchor can be found on flush.
  let listRef: HTMLDivElement | undefined;
  // The bar only exists while there are new posts, so appearing and
  // disappearing both shift the list by one bar height.
  let barRef: HTMLButtonElement | undefined;
  let wasBarVisible = false;
  let wasLoadMoreVisible = false;
  const [paginator, setPaginator] = createSignal(
    createTimeline(relayUrls(), feedAuthors() ?? undefined),
  );
  // Guards late async completions from a discarded paginator generation.
  const [generation, setGeneration] = createSignal(0);
  const [events, setEvents] = createSignal<NostrEvent[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [coverage, setCoverage] = createSignal("partial");
  const [authRelays, setAuthRelays] = createSignal<string[]>([]);
  const [pendingRelays, setPendingRelays] = createSignal<string[]>([]);
  const [hasMore, setHasMore] = createSignal(true);

  // Live subscriptions feed a buffer; the list is never mutated by them.
  onCleanup(startLiveFeed());

  // The bar is only rendered while there are new posts, so appearing
  // pushes the whole list down by one bar height. Undo that for a reader
  // who has scrolled; at the top the bar is what should be visible.
  // Removal is corrected inside flushNew, together with the prepend.
  createEffect(() => {
    const visible = buffered().length > 0;
    untrack(() => {
      if (!visible || wasBarVisible) return;
      wasBarVisible = true;
      const height = barRef?.offsetHeight ?? 0;
      if (height <= 0 || window.scrollY <= 0) return;
      window.scrollBy({ top: height, behavior: "instant" });
    });
  });

  // The load-more control is in the flow as well, so it appearing (first
  // page) or disappearing (history exhausted) has to be absorbed too.
  createEffect(() => {
    const shown = hasMore() && !loading();
    untrack(() => {
      if (shown === wasLoadMoreVisible) return;
      wasLoadMoreVisible = shown;
      preservingViewport(() => undefined);
    });
  });

  /**
   * Runs `change` while holding the viewport on the post the reader is
   * looking at. Any layout change inside - a control being added or
   * removed, posts being inserted - is absorbed, so the visible post
   * never moves.
   */
  function preservingViewport(change: () => void): void {
    const scrollBefore = window.scrollY;
    const anchor = topmostVisibleCard();
    const before = anchor === null ? null : anchor.getBoundingClientRect().top;

    change();

    if (anchor === null || before === null || !anchor.isConnected) return;
    // Solid applies updates synchronously, so the DOM is already laid out
    // here. Measuring in a later frame would let unrelated reflow (lazy
    // images, a background page load) corrupt the correction.
    const after = anchor.getBoundingClientRect().top;
    const target = Math.max(scrollBefore + (after - before), 0);
    if (target !== window.scrollY) {
      window.scrollTo({ top: target, behavior: "instant" });
    }
  }

  /**
   * Pressing the bar inserts the new posts above the current first post
   * and pins the viewport, so the reader keeps looking at the same post
   * instead of being dropped on the newest one.
   */
  function flushNew(): void {
    const plan = planFlush(buffered(), events());
    preservingViewport(() => {
      // flushNew accounts for the bar removal itself.
      wasBarVisible = false;
      clearBuffered();
      if (plan.added.length > 0) {
        setEvents(plan.events);
      }
    });
  }

  /** The post currently under the top edge of the viewport. */
  function topmostVisibleCard(): HTMLElement | null {
    if (listRef === undefined) return null;
    const cards = listRef.querySelectorAll<HTMLElement>("article");
    if (cards.length === 0) return null;
    const probeY = 8;
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      if (rect.top > probeY) break;
      if (rect.bottom > probeY) return card;
    }
    for (const card of cards) {
      if (card.getBoundingClientRect().bottom > 0) return card;
    }
    return cards[0];
  }

  async function loadMore() {
    const active = paginator();
    const gen = generation();
    if (loadingMore() || !hasMore()) return;
    setLoadingMore(true);
    try {
      const page = await active.loadNextPage();
      if (gen !== generation()) return;
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
      if (gen === generation()) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }

  // Rebuild the timeline whenever the relay set or feed filter changes.
  // untrack: loadMore reads signals that must not resubscribe this effect.
  createEffect(() => {
    relayVersion();
    feedAuthors();
    const next = createTimeline(relayUrls(), feedAuthors() ?? undefined);
    setPaginator(next);
    setGeneration((g) => g + 1);
    setEvents([]);
    setCoverage("partial");
    setAuthRelays([]);
    setPendingRelays([]);
    setHasMore(true);
    setLoading(true);
    setLoadingMore(false);
    untrack(() => void loadMore());
  });

  // Background retry: while history is still pending on retryable relays
  // (failures, not auth gates), re-attempt without user scrolling.
  createEffect(() => {
    const retryable = pendingRelays().filter(
      (url) => !authRelays().includes(url),
    );
    if (!hasMore() || loading() || loadingMore() || retryable.length === 0) {
      return;
    }
    const timer = setTimeout(() => untrack(() => void loadMore()), 15000);
    onCleanup(() => clearTimeout(timer));
  });

  return (
    <div>
      <Show when={loading()}>
        <p class="px-4 py-6 text-(--dads-solid-gray-500)">読み込み中…</p>
      </Show>
      <Show when={!loading() && events().length === 0}>
        <p class="px-4 py-6 text-(--dads-solid-gray-500)">
          イベントを取得できませんでした。リレーの接続を確認してください。
        </p>
      </Show>
      <Show when={authRelays().length > 0}>
        <p class="border-b border-(--dads-yellow-600) bg-(--dads-yellow-50) px-4 py-2 text-sm text-(--dads-solid-gray-800)">
          認証が必要なリレー: {authRelays().join(", ")}
        </p>
      </Show>
      <div ref={listRef}>
        <Show when={buffered().length > 0}>
          {/* Pinned to the top of the viewport and removed entirely on
              click. The corrections in flushNew and the effect above
              absorb the layout shift that causes. */}
          <button
            ref={barRef}
            class="sticky top-0 z-10 block w-full border-b border-(--dads-solid-gray-200) bg-white px-4 py-3 text-left hover:bg-(--dads-blue-50)"
            onClick={flushNew}
          >
            新着 {buffered().length} 件
          </button>
        </Show>
        <For each={events()}>
          {(event) => (
            <EventCard event={event} onSelect={props.onSelect} />
          )}
        </For>
        <Show when={hasMore() && !loading()}>
          {/* Same block style as the new-arrivals bar, but at the end of
              the feed where older posts continue. */}
          <button
            class="block w-full border-b border-(--dads-solid-gray-200) px-4 py-3 text-left hover:bg-(--dads-blue-50) disabled:opacity-50"
            disabled={loadingMore()}
            onClick={() => void loadMore()}
          >
            {loadingMore() ? "読み込み中…" : "さらに読み込む"}
          </button>
        </Show>
      </div>
      <Show when={!hasMore() && events().length > 0}>
        <p class="px-4 py-4 text-sm text-(--dads-solid-gray-500)">
          {coverage() === "complete" ? "履歴の末尾です" : "取得可能な履歴の末尾です (一部未確定)"}
        </p>
      </Show>
    </div>
  );
}
