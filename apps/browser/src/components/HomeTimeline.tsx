import type { NostrEvent } from "dacci-nostr-nips";
import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { createTimeline } from "../nostr.js";
import { rememberEvents } from "../event-cache.js";
import { useFeed, useRelays } from "../relays.js";
import { EventCard } from "./EventCard.jsx";

export function HomeTimeline(props: {
  onSelect: (event: NostrEvent) => void;
}) {
  const { relayUrls, relayVersion } = useRelays();
  const { feedAuthors } = useFeed();
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
