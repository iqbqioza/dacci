import type { NostrEvent } from "dacci-nostr-nips";
import { createSignal, For, Show } from "solid-js";
import { formatTime, getConnection } from "../nostr.js";

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

export function NotificationsView() {
  return (
    <p class="px-4 py-6 text-(--dads-solid-gray-500)">
      鍵を設定すると、自分の投稿へのリアクションをここに表示します。(実装中)
    </p>
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
          <div class="mt-2">
            <p class="font-mono text-sm text-(--dads-solid-gray-700)">
              {event().pubkey}
            </p>
            <p class="mt-1 text-sm text-(--dads-solid-gray-500)">
              {formatTime(event().created_at)}
            </p>
            <p class="mt-2 whitespace-pre-wrap break-words">{event().content}</p>
          </div>
        )}
      </Show>
    </div>
  );
}

export function SettingsView() {
  return (
    <div class="px-4 py-3">
      <h2 class="text-lg font-bold">Settings</h2>
      <p class="mt-2 text-(--dads-solid-gray-500)">
        テスト用リレー: wss://relay.nostrfy.org
      </p>
    </div>
  );
}
