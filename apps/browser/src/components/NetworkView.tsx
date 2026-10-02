import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import {
  addRelay,
  refreshRelayInfo,
  removeRelay,
  restoreDefaults,
  setRelayMode,
  useRelays,
  type RelayConnStatus,
  type RelayEditResult,
  type RelayInfo,
  type RelayMode,
} from "../relays.js";

const STATUS_LABEL: Record<RelayConnStatus, string> = {
  unknown: "未確認",
  checking: "確認中…",
  online: "オンライン",
  offline: "オフライン",
  auth: "認証が必要 (NIP-42)",
};

const STATUS_CLASS: Record<RelayConnStatus, string> = {
  unknown: "bg-(--unknown)",
  checking: "bg-(--warn)",
  online: "bg-(--ok)",
  offline: "bg-(--danger)",
  auth: "bg-(--auth)",
};

const MODE_LABEL: Record<RelayMode, string> = {
  both: "読み書き",
  read: "読みのみ",
  write: "書きのみ",
};

const MODE_OPTIONS: RelayMode[] = ["both", "read", "write"];

const EDIT_ERROR: Record<
  Exclude<RelayEditResult, { ok: true }>["reason"],
  string
> = {
  invalid: "wss:// で始まるリレーURLを入力してください",
  duplicate: "このリレーはすでに登録されています",
  full: "登録できるリレー数の上限に達しました",
};

interface Meta {
  label: string;
  value: string;
}

/** Retention windows read better in days once they pass a day. */
function formatDuration(seconds: number): string {
  const hours = seconds / 3600;
  if (hours >= 24) return `${Math.round(hours / 24)} 日`;
  return `${Math.round(hours * 10) / 10} 時間`;
}

function metaOf(info: RelayInfo): Meta[] {
  const out: Meta[] = [];
  if (info.software !== undefined) {
    // `software` is often a repository URL, which reads badly in full.
    const name = info.software
      .replace(/^git\+/, "")
      .replace(/^https?:\/\//, "")
      .replace(/\.git$/, "");
    out.push({
      label: "ソフトウェア",
      value: info.version === undefined ? name : `${name} ${info.version}`,
    });
  }
  if (info.contact !== undefined) out.push({ label: "連絡先", value: info.contact });
  if (info.listeners !== undefined || info.relayCount !== undefined) {
    out.push({
      label: "接続",
      value:
        info.relayCount === undefined
          ? `${info.listeners ?? 0}`
          : `${info.listeners ?? 0} / 全 ${info.relayCount}`,
    });
  }
  // The NIP-11 `limitation` block is deliberately not shown: it repeats
  // numbers most readers cannot act on.
  const retention = info.retention;
  if (retention !== undefined) {
    const parts: string[] = [];
    if (Array.isArray(retention.kinds)) {
      parts.push(`kind ${retention.kinds.join(", ")}`);
    }
    if (typeof retention.time === "number") {
      parts.push(formatDuration(retention.time));
    }
    if (retention.count === null) parts.push("件数無制限");
    if (parts.length > 0) out.push({ label: "保存", value: parts.join(" / ") });
  }
  return out;
}

/**
 * Relay set editor: add, remove and set the read/write mode of each relay,
 * and show what the relay itself says about itself. Status comes from a live
 * `limit: 0` probe of the read-capable relays; the details come from the
 * relay's NIP-11 document, with the reader's NIP-66 list filling in a name
 * and description when the relay serves neither.
 */
export function NetworkView() {
  const { relayEntries, readRelays, writeRelays, relayStatuses, relayInfo } =
    useRelays();
  const [input, setInput] = createSignal("");
  const [newMode, setNewMode] = createSignal<RelayMode>("both");
  const [error, setError] = createSignal<string | null>(null);
  const [refreshing, setRefreshing] = createSignal(false);

  // NIP-11 documents are worth having as soon as this page is opened.
  onMount(() => void refreshRelayInfo());

  const counts = createMemo(() => {
    const statuses = relayStatuses();
    const entries = relayEntries();
    return {
      total: entries.length,
      read: readRelays().length,
      write: writeRelays().length,
      online: entries.filter((e) => statuses[e.url] === "online").length,
      offline: entries.filter((e) => statuses[e.url] === "offline").length,
      auth: entries.filter((e) => statuses[e.url] === "auth").length,
      described: entries.filter((e) => relayInfo()[e.url] !== undefined).length,
    };
  });

  function add(): void {
    const result = addRelay(input(), newMode());
    if (result.ok) {
      setError(null);
      setInput("");
      return;
    }
    setError(EDIT_ERROR[result.reason]);
  }

  async function refresh(): Promise<void> {
    setRefreshing(true);
    try {
      await refreshRelayInfo();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div class="px-4 py-3">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="text-lg font-bold">リレーセット</h2>
        <span class="text-xs text-(--ink-muted)">
          {counts().total} 件 / 読み {counts().read} / 書き {counts().write}
          {" / "}
          オンライン {counts().online}
          {counts().auth > 0 ? ` / 認証 ${counts().auth}` : ""}
          {counts().offline > 0 ? ` / オフライン ${counts().offline}` : ""}
          {" / "}
          情報 {counts().described}
        </span>
      </div>

      <div class="mt-2 flex flex-wrap gap-2">
        <input
          class="min-w-0 flex-1 rounded-2xl border border-(--line-strong) px-3 py-2"
          placeholder="wss://relay.example"
          value={input()}
          onInput={(e) => {
            setInput(e.currentTarget.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <ModeSelect
          value={newMode()}
          label="追加するリレーの用途"
          onChange={setNewMode}
        />
        <button
          class="rounded-2xl bg-(--accent) px-4 py-2 text-(--on-accent) disabled:opacity-50"
          disabled={input().trim() === ""}
          onClick={add}
        >
          追加
        </button>
        <button
          class="rounded-2xl border border-(--line-strong) px-4 py-2 disabled:opacity-50"
          disabled={refreshing()}
          onClick={() => void refresh()}
        >
          {refreshing() ? "更新中…" : "情報を更新"}
        </button>
        <button
          class="rounded-2xl border border-(--line-strong) px-4 py-2"
          onClick={restoreDefaults}
        >
          初期化
        </button>
      </div>
      <Show when={error()}>
        <p class="mt-1 text-sm text-(--danger)">{error()}</p>
      </Show>
      <Show when={counts().read === 0 || counts().write === 0}>
        <p class="mt-1 text-sm text-(--warn-strong)">
          <Show
            when={counts().read === 0}
            fallback={"書き込み専用のリレーがありません。投稿は送信されません。"}
          >
            読み取り専用のリレーがありません。フィードと通知は取得できません。
          </Show>
        </p>
      </Show>

      <ul class="mt-3">
        <For each={relayEntries()}>
          {(entry) => <RelayRow url={entry.url} mode={entry.mode} />}
        </For>
      </ul>
      <p class="mt-3 text-xs text-(--ink-muted)">
        名前・説明・アイコン・対応 NIP・連絡先・ソフトウェアなどは、リレーの NIP-11
        ドキュメント (Accept: application/nostr+json) から取得します。読み取り専用のリレーはタイムライン・通知・プロフィール取得に、書き込み専用のリレーは投稿の配信にだけ使われます。ログイン時に NIP-65
        のリレー一覧を取得した場合は、その一覧の read/write 設定が優先されます。
      </p>
    </div>
  );
}

function RelayRow(props: { url: string; mode: RelayMode }) {
  const { relayStatuses, relayInfo } = useRelays();
  const status = (): RelayConnStatus =>
    relayStatuses()[props.url] ?? "unknown";
  const info = (): RelayInfo => relayInfo()[props.url] ?? {};
  const nips = (): string[] => info().supportedNips ?? [];
  const facts = (): Meta[] => metaOf(info());
  const [iconBroken, setIconBroken] = createSignal(false);
  const icon = (): string | null =>
    iconBroken() ? null : (info().icon ?? null);

  return (
    <li class="border-b border-(--line) py-3">
      <div class="flex items-start gap-2">
        <Show
          when={icon()}
          fallback={
            <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-(--fill) text-xs text-(--ink-quiet)">
              {hostOf(props.url).slice(0, 2).toUpperCase()}
            </span>
          }
        >
          {(url) => (
            <img
              src={url()}
              alt=""
              class="h-8 w-8 shrink-0 rounded-lg object-cover"
              loading="lazy"
              decoding="async"
              // The icon is on someone else's host, which has no business
              // knowing which reader's session pulled it.
              referrerpolicy="no-referrer"
              onError={() => setIconBroken(true)}
            />
          )}
        </Show>

        <div class="min-w-0 flex-1">
          {/* The relay's own name is the heading, with its state beside it;
              the URL identifies it underneath. */}
          <p class="flex flex-wrap items-center gap-x-2">
            <span class="text-sm font-bold">
              {info().name ?? hostOf(props.url)}
            </span>
            <span class="flex items-center gap-1 text-xs text-(--ink-quiet)">
              <span
                class={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_CLASS[status()]}`}
                aria-hidden="true"
              />
              {STATUS_LABEL[status()]}
            </span>
          </p>
          <p class="break-all font-mono text-xs text-(--ink-quiet)">
            {props.url}
          </p>

          <Show when={facts().length > 0 || nips().length > 0}>
            <table class="mt-1 w-full table-fixed border-collapse text-xs">
              <tbody>
                <Show when={info().description}>
                  <tr>
                    <RowLabel>説明</RowLabel>
                    <td class="px-0 pb-1 align-top break-words text-(--ink)">
                      {info().description}
                    </td>
                  </tr>
                </Show>
                <For each={facts()}>
                  {(fact) => (
                    <tr>
                      <RowLabel>{fact.label}</RowLabel>
                      <td class="px-0 pb-1 align-top break-words text-(--ink)">
                        {fact.value}
                      </td>
                    </tr>
                  )}
                </For>
                <Show when={nips().length > 0}>
                  <tr>
                    <RowLabel>
                      対応 NIP ({nips().length})
                    </RowLabel>
                    <td class="px-0 pb-1 align-top">
                      <ul
                        class="flex flex-wrap gap-1"
                        title={(info().supportedNips ?? []).join(", ")}
                      >
                        <For each={nips()}>
                          {(nip) => (
                            <li
                              class="rounded-md bg-(--accent-soft) px-1.5 py-0.5 font-mono whitespace-nowrap text-(--accent-ink)"
                              title={`NIP-${nip}`}
                            >
                              {nip}
                            </li>
                          )}
                        </For>
                      </ul>
                    </td>
                  </tr>
                </Show>
              </tbody>
            </table>
          </Show>
        </div>

        <div class="flex shrink-0 items-center gap-1">
          <ModeSelect
            value={props.mode}
            label={`${props.url} の用途`}
            onChange={(mode) => setRelayMode(props.url, mode)}
          />
          <button
            class="rounded-full px-2 py-1 text-xs text-(--ink-muted) hover:bg-(--line) hover:text-(--danger)"
            title="このリレーを削除"
            onClick={() => removeRelay(props.url)}
          >
            削除
          </button>
        </div>
      </div>
    </li>
  );
}

/** Label column of the relay facts table. */
function RowLabel(props: { children: unknown }) {
  return (
    <th
      scope="row"
      class="w-24 py-0 pr-2 text-left align-top font-normal whitespace-nowrap text-(--ink-muted)"
    >
      {props.children as never}
    </th>
  );
}

function hostOf(url: string): string {
  return url.replace(/^wss?:\/\//, "").split("/")[0];
}

function ModeSelect(props: {
  value: RelayMode;
  label: string;
  onChange: (mode: RelayMode) => void;
}) {
  return (
    <select
      aria-label={props.label}
      class="rounded-2xl border border-(--line-strong) bg-(--surface) px-2 py-1 text-xs"
      value={props.value}
      onChange={(e) => props.onChange(e.currentTarget.value as RelayMode)}
    >
      <For each={MODE_OPTIONS}>
        {(mode) => <option value={mode}>{MODE_LABEL[mode]}</option>}
      </For>
    </select>
  );
}
