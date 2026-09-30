import type { NostrEvent } from "dacci-nostr-nips";
import { createSignal, For, onMount, Show } from "solid-js";
import { createTimeline, DEFAULT_RELAYS } from "../nostr.js";
import { EventCard } from "./EventCard.jsx";

export function HomeTimeline(props: {
  onSelect: (event: NostrEvent) => void;
}) {
  const paginator = createTimeline(DEFAULT_RELAYS);
  const [events, setEvents] = createSignal<NostrEvent[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [coverage, setCoverage] = createSignal("partial");
  const [authRelays, setAuthRelays] = createSignal<string[]>([]);
  const [hasMore, setHasMore] = createSignal(true);

  async function loadMore() {
    if (loadingMore() || !hasMore()) return;
    setLoadingMore(true);
    try {
      const page = await paginator.loadNextPage();
      setEvents((prev) => [...prev, ...page.events]);
      setCoverage(page.coverage);
      setAuthRelays(page.authRequiredRelays);
      setHasMore(paginator.hasMore() && page.events.length > 0);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }

  onMount(() => {
    void loadMore();
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
      <For each={events()}>{(event) => <EventCard event={event} onSelect={props.onSelect} />}</For>
      <Show when={hasMore() && !loading()}>
        <button
          class="m-4 rounded-2xl bg-(--dads-blue-700) px-4 py-2 text-white disabled:opacity-50"
          disabled={loadingMore()}
          onClick={() => void loadMore()}
        >
          {loadingMore() ? "読み込み中…" : "さらに読み込む"}
        </button>
      </Show>
      <Show when={!hasMore() && events().length > 0}>
        <p class="px-4 py-4 text-sm text-(--dads-solid-gray-500)">
          {coverage() === "complete" ? "履歴の末尾です" : "取得可能な履歴の末尾です (一部未確定)"}
        </p>
      </Show>
    </div>
  );
}
