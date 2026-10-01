import type { NostrEvent } from "dacci-nostr-nips";
import { createEffect, createSignal, For, onMount, Show } from "solid-js";
import {
  extensionAvailable,
  loginWithExtension,
  loginWithNsec,
  logout,
  useAuth,
} from "../auth.jsx";
import {
  ensureNotifications,
  flushNotificationArrivals,
  loadMoreNotifications,
  useNotifications,
} from "../notifications-feed.js";
import { useNotificationLive } from "../live.js";
import { useSensitiveMode, type SensitiveMode } from "../sensitive.js";
import { useTheme, type Theme } from "../theme.js";
import { Choices } from "./Choices.jsx";
import { EventCard } from "./EventCard.jsx";

function newestFirst(a: NostrEvent, b: NostrEvent): number {
  return a.created_at !== b.created_at
    ? b.created_at - a.created_at
    : a.id < b.id
      ? -1
      : 1;
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
          <p class="px-4 py-6 text-(--ink-muted)">
            通知を見るにはログインしてください。
          </p>
        }
      >
        <Show when={buffered().length > 0}>
          {/* It pins above the page bar, since a new arrival is the more
              urgent of the two and the bar is already at the top. */}
          <button
            class="sticky top-0 z-30 block w-full border-b border-(--line) bg-(--surface) px-4 py-3 text-left hover:bg-(--accent-soft)"
            onClick={flushNotificationArrivals}
          >
            新着 {buffered().length} 件
          </button>
        </Show>
        <Show when={feed.loading() && feed.events().length === 0}>
          <p class="px-4 py-6 text-(--ink-muted)">読み込み中…</p>
        </Show>
        <Show when={!feed.loading() && feed.events().length === 0}>
          <p class="px-4 py-6 text-(--ink-muted)">
            自分へのメンション・リアクションはまだありません。
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
            <button
              class="block w-full border-b border-(--line) px-4 py-3 text-left hover:bg-(--accent-soft) disabled:opacity-50"
              disabled={feed.loadingMore()}
              onClick={loadMoreNotifications}
            >
              {feed.loadingMore() ? "読み込み中…" : "さらに読み込む"}
            </button>
          </Show>
        </div>
        <Show when={!feed.hasMore() && feed.events().length > 0}>
          <p class="px-4 py-4 text-sm text-(--ink-muted)">
            {feed.coverage() === "complete"
              ? "通知の末尾です"
              : "取得可能な通知の末尾です (一部未確定)"}
          </p>
        </Show>
      </Show>
    </div>
  );
}

export function SettingsView() {
  const { pubkey, method, authError, restoring } = useAuth();
  const [nsec, setNsec] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const { theme, setTheme } = useTheme();
  const { mode: sensitive, setMode: setSensitiveMode } = useSensitiveMode();

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
      <p class="mt-2 text-(--ink-muted)">
        テスト用リレー: wss://relay.nostrfy.org
      </p>

      <h3 class="mt-6 font-bold">表示</h3>
      <p class="mt-1 text-sm text-(--ink-muted)">
        背景に合わせて本文・罫線・アクセントのコントラストを切り替えます。システムを選ぶと端末の設定に追従します。
      </p>
      <ThemeChoice theme={theme} onSelect={setTheme} />

      <h3 class="mt-6 font-bold">センシティブコンテンツ</h3>
      <p class="mt-1 text-sm text-(--ink-muted)">
        投稿に NIP-36
        の警告タグがあるとき、本文を隠す範囲を選びます。引用された投稿の警告もそれぞれの投稿として扱います。
      </p>
      <SensitiveChoice mode={sensitive} onSelect={setSensitiveMode} />

      <h3 class="mt-6 font-bold">ログイン</h3>
      <Show
        when={pubkey()}
        fallback={
          <div class="mt-2">
            <button
              class="rounded-2xl bg-(--accent) px-4 py-2 text-(--on-accent) disabled:opacity-50"
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
              <p class="mt-1 text-sm text-(--ink-muted)">
                拡張が検出できません。対応拡張を導入するか、nsecでログインしてください。
              </p>
            </Show>
            <Show when={restoring()}>
              <p class="mt-1 text-sm text-(--ink-muted)">
                拡張を確認しています… (数秒で完了します)
              </p>
            </Show>
            <div class="mt-3 flex gap-2">
              <input
                class="min-w-0 flex-1 rounded-2xl border border-(--line-strong) px-3 py-2"
                type="password"
                placeholder="nsec1… または64桁hex"
                value={nsec()}
                onInput={(e) => setNsec(e.currentTarget.value)}
              />
              <button
                class="rounded-2xl border border-(--line-strong) px-4 py-2 disabled:opacity-50"
                disabled={busy() || nsec().trim() === ""}
                onClick={() => void doNsecLogin()}
              >
                nsecでログイン
              </button>
            </div>
            <p class="mt-1 text-sm text-(--ink-muted)">
              秘密鍵はセッション内 (タブを閉じるまで) のみ保持します。
            </p>
          </div>
        }
      >
        <div class="mt-2">
          <p class="font-mono text-sm break-all">{pubkey()}</p>
          <p class="text-sm text-(--ink-muted)">
            {method() === "nip07" ? "拡張経由でログイン中" : "nsec (セッションのみ) でログイン中"}
          </p>
          <button
            class="mt-2 rounded-2xl border border-(--line-strong) px-4 py-2"
            onClick={logout}
          >
            ログアウト
          </button>
        </div>
      </Show>
      <Show when={authError()}>
        <p class="mt-2 text-sm text-(--danger)">{authError()}</p>
      </Show>
    </div>
  );
}

const THEME_CHOICES: Array<{ id: Theme; label: string; swatch: string }> = [
  { id: "system", label: "システム", swatch: "linear-gradient(105deg, #ffffff 50%, #111111 50%)" },
  { id: "light", label: "ライト", swatch: "#ffffff" },
  { id: "dark", label: "ダーク", swatch: "#111111" },
];

/**
 * The theme, as one choice rather than a switch: `system` is a real answer
 * and not a fourth "off" state, so it belongs beside the two it resolves to.
 * Each swatch is painted with the colours the theme sets, so the choice can
 * be judged from the row itself instead of by pressing it and looking.
 */
function ThemeChoice(props: {
  theme: () => Theme;
  onSelect: (next: Theme) => void;
}) {
  return (
    <Choices
      label="テーマ"
      options={THEME_CHOICES}
      value={props.theme}
      onSelect={props.onSelect}
    />
  );
}

const SENSITIVE_CHOICES: Array<{ id: SensitiveMode; label: string; swatch: string }> = [
  { id: "show", label: "すべて表示", swatch: "#ffffff" },
  { id: "blur", label: "ぼかす", swatch: "#b3b3b3" },
  { id: "hide", label: "表示しない", swatch: "#111111" },
];

/**
 * What a post that carries a NIP-36 warning is shown as. The swatch is the
 * covering itself, so the three answers can be told apart by looking at them.
 */
function SensitiveChoice(props: {
  mode: () => SensitiveMode;
  onSelect: (next: SensitiveMode) => void;
}) {
  return (
    <Choices
      label="センシティブコンテンツ"
      options={SENSITIVE_CHOICES}
      value={props.mode}
      onSelect={props.onSelect}
    />
  );
}
