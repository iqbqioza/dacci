import type { NostrEvent } from "dacci-nostr-nips";
import { createEffect, For, onCleanup, Show, untrack } from "solid-js";
import {
  flushNewArrivals,
  loadMoreHome,
  noteBarVisibility,
  noteLoadMoreVisibility,
  useHomeFeed,
} from "../home-feed.js";
import { useFeedLive } from "../live.js";
import { EventCard } from "./EventCard.jsx";

export function HomeTimeline(props: {
  onSelect: (event: NostrEvent) => void;
}) {
  const feed = useHomeFeed();
  const { buffered } = useFeedLive();

  createEffect(() => {
    untrack(() => noteBarVisibility(buffered().length > 0));
  });

  createEffect(() => {
    untrack(() => noteLoadMoreVisibility(feed.hasMore() && !feed.loading()));
  });

  // Background retry: while history is still pending on retryable relays
  // (failures, not auth gates), re-attempt without user scrolling.
  createEffect(() => {
    const retryable = feed
      .pendingRelays()
      .filter((url) => !feed.authRelays().includes(url));
    if (
      !feed.hasMore() ||
      feed.loading() ||
      feed.loadingMore() ||
      retryable.length === 0
    ) {
      return;
    }
    const timer = setTimeout(
      () => untrack(() => void loadMoreHome()),
      15000,
    );
    onCleanup(() => clearTimeout(timer));
  });

  return (
    <div>
      <Show when={buffered().length > 0}>
        {/* Pinned to the top of the viewport and removed entirely on
            click. The corrections absorb the layout shift that causes. */}
        <button
          ref={feed.setBarRef}
          class="sticky top-0 z-10 block w-full border-b border-(--dads-solid-gray-200) bg-white px-4 py-3 text-left hover:bg-(--dads-blue-50)"
          onClick={flushNewArrivals}
        >
          新着 {buffered().length} 件
        </button>
      </Show>
      <Show when={feed.loading()}>
        <p class="px-4 py-6 text-(--dads-solid-gray-500)">読み込み中…</p>
      </Show>
      <Show when={!feed.loading() && feed.events().length === 0}>
        <p class="px-4 py-6 text-(--dads-solid-gray-500)">
          イベントを取得できませんでした。リレーの接続を確認してください。
        </p>
      </Show>
      <Show when={feed.authRelays().length > 0}>
        <p class="border-b border-(--dads-yellow-600) bg-(--dads-yellow-50) px-4 py-2 text-sm text-(--dads-solid-gray-800)">
          認証が必要なリレー: {feed.authRelays().join(", ")}
        </p>
      </Show>
      <div ref={feed.setListRef}>
        <For each={feed.events()}>
          {(event) => (
            <EventCard event={event} onSelect={props.onSelect} />
          )}
        </For>
        <Show when={feed.hasMore() && !feed.loading()}>
          {/* Same block style as the new-arrivals bar, at the end of the
              feed where older posts continue. */}
          <button
            class="block w-full border-b border-(--dads-solid-gray-200) px-4 py-3 text-left hover:bg-(--dads-blue-50) disabled:opacity-50"
            disabled={feed.loadingMore()}
            onClick={() => void loadMoreHome()}
          >
            {feed.loadingMore() ? "読み込み中…" : "さらに読み込む"}
          </button>
        </Show>
      </div>
      <Show when={!feed.hasMore() && feed.events().length > 0}>
        <p class="px-4 py-4 text-sm text-(--dads-solid-gray-500)">
          {feed.coverage() === "complete"
            ? "履歴の末尾です"
            : "取得可能な履歴の末尾です (一部未確定)"}
        </p>
      </Show>
    </div>
  );
}
