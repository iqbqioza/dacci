import type { NostrEvent } from "dacci-nostr-nips";
import { createEffect, For, Show, untrack } from "solid-js";
import { FeedTabs, type FeedTab } from "../feed-tabs.jsx";
import {
  flushNewArrivals,
  loadMoreHome,
  noteBarVisibility,
  noteLoadMoreVisibility,
  selectHomeTab,
  useHomeFeed,
} from "../home-feed.js";
import { retryWhilePending } from "../feed-retry.js";
import { useFeedLive } from "../live.js";
import { feedHash, navigate } from "../router.js";
import { EventCard } from "./EventCard.jsx";

export function HomeTimeline(props: {
  /** True while the URL asks for the Replies and notes tab. */
  replies: boolean;
  onSelect: (event: NostrEvent) => void;
}) {
  const feed = useHomeFeed();
  const { buffered } = useFeedLive();

  // The URL is the single source of truth for the tab, so a shared link
  // lands on the tab it names and the back button walks the tab history.
  createEffect(() => {
    const next: FeedTab = props.replies ? "replies" : "notes";
    untrack(() => {
      if (feed.tab() !== next) selectHomeTab(next);
    });
  });

  // Clicking a tab rewrites the URL, which routes back here and applies it.
  const onTab = (tab: FeedTab): void => {
    navigate(feedHash("#/home", tab === "replies"));
  };

  // The signal is read *outside* `untrack`. Reading it inside left the effect
  // tracking nothing, so it ran once for the life of the page and the arrivals
  // bar appeared with no correction at all — the list jumped down by the bar's
  // whole height every single time something arrived, which is the common case
  // in an active timeline. Only the measurement and the scroll move belong
  // untracked; they are the effect's own work, not its trigger.
  createEffect(() => {
    const arriving = buffered().length > 0;
    untrack(() => noteBarVisibility(arriving));
  });

  createEffect(() => {
    const more = feed.hasMore() && !feed.loading();
    untrack(() => noteLoadMoreVisibility(more));
  });

  // Background retry: while history is still pending on retryable relays
  // (failures, not auth gates), re-attempt without user scrolling.
  retryWhilePending(feed, loadMoreHome);

  return (
    <div>
      {/* The tab row and the new-arrivals bar share one sticky container:
          the tabs stay reachable while scrolling, and the bar appears and
          disappears below them without ever covering them. */}
      <div
        ref={feed.setHeaderRef}
        class="sticky top-0 z-20 bg-(--surface)"
      >
        <FeedTabs tab={feed.tab()} onSelect={onTab} />
        <Show when={buffered().length > 0}>
          <button
            ref={feed.setBarRef}
            class="block w-full border-b border-(--line) px-4 py-3 text-left hover:bg-(--accent-soft)"
            onClick={flushNewArrivals}
          >
            新着 {buffered().length} 件
          </button>
        </Show>
      </div>
      <Show when={feed.loading()}>
        <p class="px-4 py-6 text-(--ink-muted)">読み込み中…</p>
      </Show>
      <Show when={!feed.loading() && feed.events().length === 0}>
        {/* One message for both cases sent a reader to check their relay list
            over a feed that was merely empty, and hid the one case that was
            actually a failure behind a page of nothing. */}
        <p class="px-4 py-6 text-(--ink-muted)">
          {feed.failed()
            ? "イベントを取得できませんでした。リレーの接続を確認してください。"
            : "まだ投稿がありません。"}
        </p>
      </Show>
      <Show when={feed.authRelays().length > 0}>
        <p class="border-b border-(--warn) bg-(--warn-soft) px-4 py-2 text-sm text-(--warn-ink)">
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
            class="block w-full border-b border-(--line) px-4 py-3 text-left hover:bg-(--accent-soft) disabled:opacity-50"
            disabled={feed.loadingMore()}
            onClick={() => void loadMoreHome()}
          >
            {feed.loadingMore() ? "読み込み中…" : "さらに読み込む"}
          </button>
        </Show>
      </div>
      <Show when={!feed.hasMore() && feed.events().length > 0}>
        <p class="px-4 py-4 text-sm text-(--ink-muted)">
          {feed.coverage() === "complete"
            ? "履歴の末尾です"
            : "取得可能な履歴の末尾です (一部未確定)"}
        </p>
      </Show>
    </div>
  );
}
