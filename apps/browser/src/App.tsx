import type { NostrEvent } from "dacci-nostr-nips";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { HomeTimeline } from "./components/HomeTimeline.jsx";
import {
  NetworkView,
  NotificationsView,
  ProfileView,
  SettingsView,
} from "./components/Views.jsx";

type Menu = "home" | "notifications" | "network" | "profile" | "settings";

const MENU_LABELS: Array<{ key: Menu; label: string }> = [
  { key: "home", label: "Home" },
  { key: "notifications", label: "Notification" },
  { key: "network", label: "Network" },
  { key: "profile", label: "Profile" },
  { key: "settings", label: "Settings" },
];

export function App() {
  const [menu, setMenu] = createSignal<Menu>("home");
  const [composeOpen, setComposeOpen] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  // Detail stack inside the main column: push from timeline,
  // pop with the back button.
  const [stack, setStack] = createSignal<NostrEvent[]>([]);

  function openMenu(key: Menu) {
    setMenu(key);
    setStack([]);
  }

  function openDetail(event: NostrEvent) {
    setStack((prev) => [...prev, event]);
  }

  function goBack() {
    setStack((prev) => prev.slice(0, -1));
  }

  const detail = () => stack()[stack().length - 1] ?? null;

  return (
    <div class="mx-auto flex min-h-screen max-w-6xl">
      {/* Menu */}
      <nav class="w-48 shrink-0 border-r border-(--dads-solid-gray-200) p-3">
        <h1 class="px-2 py-2 text-xl font-bold text-(--dads-blue-700)">Dacci</h1>
        <ul>
          <For each={MENU_LABELS}>
            {(item) => (
              <li>
                <button
                  class="w-full rounded-2xl px-3 py-2 text-left hover:bg-(--dads-blue-50)"
                  classList={{
                    "bg-(--dads-blue-50) font-bold": menu() === item.key,
                  }}
                  onClick={() => openMenu(item.key)}
                >
                  {item.label}
                </button>
              </li>
            )}
          </For>
        </ul>
        <button
          class="mt-3 w-full rounded-2xl bg-(--dads-blue-700) px-3 py-2 text-white"
          onClick={() => setComposeOpen(true)}
        >
          Compose
        </button>
      </nav>

      {/* Main column */}
      <main class="min-w-0 flex-1 border-r border-(--dads-solid-gray-200)">
        <Show when={detail()} fallback={<MenuContent menu={menu()} onSelect={openDetail} />}>
          {(event) => (
            <div>
              <button
                class="m-3 rounded-2xl border border-(--dads-solid-gray-300) px-3 py-1"
                onClick={goBack}
              >
                ← 戻る
              </button>
              <ProfileView event={event()} />
            </div>
          )}
        </Show>
      </main>

      {/* Reserved sidebar */}
      <aside class="hidden w-72 shrink-0 p-4 md:block">
        <p class="text-sm text-(--dads-solid-gray-500)">サイドバー (予約)</p>
      </aside>

      {/* Compose modal */}
      <Show when={composeOpen()}>
        <div class="fixed inset-0 flex items-center justify-center bg-black/40">
          <div class="w-full max-w-md rounded-2xl bg-white p-4">
            <h2 class="font-bold">Compose</h2>
            <textarea
              class="mt-2 h-32 w-full rounded-2xl border border-(--dads-solid-gray-300) p-2"
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
            />
            <p class="mt-1 text-sm text-(--dads-solid-gray-500)">
              投稿には鍵管理が必要です (未実装のため送信できません)。
            </p>
            <div class="mt-3 flex justify-end gap-2">
              <button
                class="rounded-2xl border border-(--dads-solid-gray-300) px-4 py-2"
                onClick={() => setComposeOpen(false)}
              >
                閉じる
              </button>
              <button
                class="rounded-2xl bg-(--dads-blue-700) px-4 py-2 text-white opacity-50"
                disabled
                title="鍵管理の実装後に有効化"
              >
                投稿
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}

function MenuContent(props: {
  menu: Menu;
  onSelect: (event: NostrEvent) => void;
}) {
  return (
    <Switch>
      <Match when={props.menu === "home"}>
        <HomeTimeline onSelect={props.onSelect} />
      </Match>
      <Match when={props.menu === "notifications"}>
        <NotificationsView />
      </Match>
      <Match when={props.menu === "network"}>
        <NetworkView />
      </Match>
      <Match when={props.menu === "profile"}>
        <ProfileView event={null} />
      </Match>
      <Match when={props.menu === "settings"}>
        <SettingsView />
      </Match>
    </Switch>
  );
}
