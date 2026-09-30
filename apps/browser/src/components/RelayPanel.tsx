import { For } from "solid-js";
import {
  refreshStatuses,
  useRelays,
  type RelayConnStatus,
  type RelayMode,
} from "../relays.js";

/** A write-only relay is never probed, so say what it is for. */
const MODE_MARK: Record<RelayMode, string> = {
  both: "R/W",
  read: "R",
  write: "W",
};

const DOT: Record<RelayConnStatus, string> = {
  unknown: "background-color: var(--dads-solid-gray-400)",
  checking: "background-color: var(--dads-yellow-500)",
  online: "background-color: var(--dads-green-600)",
  offline: "background-color: var(--dads-red-600)",
  auth: "background-color: var(--dads-orange-600)",
};

const LABEL: Record<RelayConnStatus, string> = {
  unknown: "未確認",
  checking: "確認中",
  online: "オンライン",
  offline: "オフライン",
  auth: "認証が必要",
};

/** Debug panel: connected relays and their connection state. */
export function RelayDebugPanel() {
  const { relayEntries, relayStatuses } = useRelays();

  return (
    <div>
      <div class="flex items-center justify-between">
        <p class="text-sm font-bold">接続リレー (debug)</p>
        <button
          class="rounded-2xl border border-(--dads-solid-gray-300) px-2 py-1 text-xs"
          onClick={() => void refreshStatuses()}
        >
          更新
        </button>
      </div>
      <ul class="mt-2">
        <For each={relayEntries()}>
          {(entry) => (
            <li class="flex items-center gap-2 py-1">
              <span
                class="inline-block h-2 w-2 shrink-0 rounded-full"
                style={DOT[relayStatuses()[entry.url] ?? "unknown"]}
                title={LABEL[relayStatuses()[entry.url] ?? "unknown"]}
              />
              <span class="min-w-0 flex-1 truncate font-mono text-xs">
                {entry.url.replace(/^wss:\/\//, "")}
              </span>
              <span class="shrink-0 text-(--dads-solid-gray-500) text-[10px]">
                {MODE_MARK[entry.mode]}
              </span>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
