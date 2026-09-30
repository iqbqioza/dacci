import type { NostrEvent } from "dacci-nostr-nips";
import { createEffect, createSignal, For, onMount, Show } from "solid-js";
import {
  extensionAvailable,
  loginWithExtension,
  loginWithNsec,
  logout,
  useAuth,
} from "../auth.jsx";
import { formatTime, getConnection } from "../nostr.js";
import {
  ensureNotifications,
  flushNotificationArrivals,
  loadMoreNotifications,
  useNotifications,
} from "../notifications-feed.js";
import { useNotificationLive } from "../live.js";
import { EventCard } from "./EventCard.jsx";
import { ProfileAvatar, ProfileName } from "./ProfileAvatar.jsx";

function newestFirst(a: NostrEvent, b: NostrEvent): number {
  return a.created_at !== b.created_at
    ? b.created_at - a.created_at
    : a.id < b.id
      ? -1
      : 1;
}

interface RelayRow {
  url: string;
  status: string;
}

export function NetworkView() {
  const [relays, setRelays] = createSignal<RelayRow[]>([
    { url: "wss://relay.nostrfy.org", status: "未確認" },
  ]);
  const [input, setInput] = createSignal("");
  const [checking, setChecking] = createSignal(false);

  async function check(url: string) {
    setRelays((prev) =>
      prev.map((r) => (r.url === url ? { ...r, status: "確認中…" } : r)),
    );
    try {
      // limit: 0 fetches no stored events; EOSE alone proves reachability.
      const result = await getConnection(url).query({ limit: 0 }, 8000);
      const status = result.failed
        ? result.authRequired
          ? "認証が必要 (NIP-42)"
          : "オフライン"
        : "オンライン";
      setRelays((prev) =>
        prev.map((r) => (r.url === url ? { ...r, status } : r)),
      );
    } catch {
      setRelays((prev) =>
        prev.map((r) => (r.url === url ? { ...r, status: "オフライン" } : r)),
      );
    }
  }

  async function checkAll() {
    setChecking(true);
    try {
      await Promise.all(relays().map((r) => check(r.url)));
    } finally {
      setChecking(false);
    }
  }

  function add() {
    const url = input().trim();
    if (url === "" || relays().some((r) => r.url === url)) return;
    setRelays((prev) => [...prev, { url, status: "未確認" }]);
    setInput("");
    void check(url);
  }

  return (
    <div class="px-4 py-3">
      <h2 class="text-lg font-bold">Network (my relays)</h2>
      <div class="mt-3 flex gap-2">
        <input
          class="min-w-0 flex-1 rounded-2xl border border-(--dads-solid-gray-300) px-3 py-2"
          placeholder="wss://relay.example"
          value={input()}
          onInput={(e) => setInput(e.currentTarget.value)}
        />
        <button
          class="rounded-2xl bg-(--dads-blue-700) px-4 py-2 text-white"
          onClick={add}
        >
          追加
        </button>
        <button
          class="rounded-2xl border border-(--dads-solid-gray-300) px-4 py-2"
          disabled={checking()}
          onClick={() => void checkAll()}
        >
          全件確認
        </button>
      </div>
      <ul class="mt-3">
        <For each={relays()}>
          {(relay) => (
            <li class="flex items-center justify-between border-b border-(--dads-solid-gray-200) py-2">
              <span class="font-mono text-sm">{relay.url}</span>
              <span class="text-sm text-(--dads-solid-gray-600)">{relay.status}</span>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

export function NotificationsView(props: {
  onSelect: (event: NostrEvent) => void;
}) {
  const { pubkey } = useAuth();
  const { buffered } = useNotificationLive();
  const feed = useNotifications();

  // Live subscriptions run app-wide; this only seeds history the first time.
  onMount(() => {
    ensureNotifications(pubkey());
  });
  createEffect(() => {
    ensureNotifications(pubkey());
  });

  return (
    <div>
      <Show
        when={pubkey()}
        fallback={
          <p class="px-4 py-6 text-(--dads-solid-gray-500)">
            通知を見るにはログインしてください。
          </p>
        }
      >
        <Show when={buffered().length > 0}>
          <button
            class="sticky top-0 z-10 block w-full border-b border-(--dads-solid-gray-200) bg-white px-4 py-3 text-left hover:bg-(--dads-blue-50)"
            onClick={flushNotificationArrivals}
          >
            新着 {buffered().length} 件
          </button>
        </Show>
        <Show when={feed.loading() && feed.events().length === 0}>
          <p class="px-4 py-6 text-(--dads-solid-gray-500)">読み込み中…</p>
        </Show>
        <Show when={!feed.loading() && feed.events().length === 0}>
          <p class="px-4 py-6 text-(--dads-solid-gray-500)">
            自分へのメンション・リアクションはまだありません。
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
            <button
              class="block w-full border-b border-(--dads-solid-gray-200) px-4 py-3 text-left hover:bg-(--dads-blue-50) disabled:opacity-50"
              disabled={feed.loadingMore()}
              onClick={loadMoreNotifications}
            >
              {feed.loadingMore() ? "読み込み中…" : "さらに読み込む"}
            </button>
          </Show>
        </div>
        <Show when={!feed.hasMore() && feed.events().length > 0}>
          <p class="px-4 py-4 text-sm text-(--dads-solid-gray-500)">
            {feed.coverage() === "complete"
              ? "通知の末尾です"
              : "取得可能な通知の末尾です (一部未確定)"}
          </p>
        </Show>
      </Show>
    </div>
  );
}

export function ProfileView(props: { event: NostrEvent | null }) {
  return (
    <div class="px-4 py-3">
      <h2 class="text-lg font-bold">Profile</h2>
      <Show
        when={props.event}
        fallback={
          <p class="mt-2 text-(--dads-solid-gray-500)">
            タイムラインの投稿を選択すると、ここに詳細を表示します。
          </p>
        }
      >
        {(event) => (
          <div class="mt-2 flex gap-3">
            <ProfileAvatar pubkey={event().pubkey} size={48} />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-baseline gap-x-2">
                <ProfileName pubkey={event().pubkey} />
                <span class="text-xs text-(--dads-solid-gray-500)">
                  {formatTime(event().created_at)}
                </span>
              </div>
              <p class="mt-0.5 font-mono text-xs break-all text-(--dads-solid-gray-500)">
                {event().pubkey}
              </p>
              <p class="mt-1 whitespace-pre-wrap break-words">
                {event().content}
              </p>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}

export function SettingsView() {
  const { pubkey, method, authError, restoring } = useAuth();
  const [nsec, setNsec] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  async function doExtensionLogin() {
    setBusy(true);
    try {
      await loginWithExtension();
    } finally {
      setBusy(false);
    }
  }

  async function doNsecLogin() {
    setBusy(true);
    try {
      if (await loginWithNsec(nsec())) setNsec("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="px-4 py-3">
      <h2 class="text-lg font-bold">Settings</h2>
      <p class="mt-2 text-(--dads-solid-gray-500)">
        テスト用リレー: wss://relay.nostrfy.org
      </p>

      <h3 class="mt-6 font-bold">ログイン</h3>
      <Show
        when={pubkey()}
        fallback={
          <div class="mt-2">
            <button
              class="rounded-2xl bg-(--dads-blue-700) px-4 py-2 text-white disabled:opacity-50"
              disabled={busy() || restoring() || !extensionAvailable()}
              onClick={() => void doExtensionLogin()}
              title={
                restoring()
                  ? "拡張を確認しています"
                  : extensionAvailable()
                    ? "NIP-07拡張でログイン"
                    : "NIP-07拡張が見つかりません"
              }
            >
              ブラウザ拡張でログイン (NIP-07)
            </button>
            <Show
              when={!restoring() && !extensionAvailable()}
            >
              <p class="mt-1 text-sm text-(--dads-solid-gray-500)">
                拡張が検出できません。対応拡張を導入するか、nsecでログインしてください。
              </p>
            </Show>
            <Show when={restoring()}>
              <p class="mt-1 text-sm text-(--dads-solid-gray-500)">
                拡張を確認しています… (数秒で完了します)
              </p>
            </Show>
            <div class="mt-3 flex gap-2">
              <input
                class="min-w-0 flex-1 rounded-2xl border border-(--dads-solid-gray-300) px-3 py-2"
                type="password"
                placeholder="nsec1… または64桁hex"
                value={nsec()}
                onInput={(e) => setNsec(e.currentTarget.value)}
              />
              <button
                class="rounded-2xl border border-(--dads-solid-gray-300) px-4 py-2 disabled:opacity-50"
                disabled={busy() || nsec().trim() === ""}
                onClick={() => void doNsecLogin()}
              >
                nsecでログイン
              </button>
            </div>
            <p class="mt-1 text-sm text-(--dads-solid-gray-500)">
              秘密鍵はセッション内 (タブを閉じるまで) のみ保持します。
            </p>
          </div>
        }
      >
        <div class="mt-2">
          <p class="font-mono text-sm break-all">{pubkey()}</p>
          <p class="text-sm text-(--dads-solid-gray-500)">
            {method() === "nip07" ? "拡張経由でログイン中" : "nsec (セッションのみ) でログイン中"}
          </p>
          <button
            class="mt-2 rounded-2xl border border-(--dads-solid-gray-300) px-4 py-2"
            onClick={logout}
          >
            ログアウト
          </button>
        </div>
      </Show>
      <Show when={authError()}>
        <p class="mt-2 text-sm text-(--dads-red-600)">{authError()}</p>
      </Show>
    </div>
  );
}
