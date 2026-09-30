import type { NostrEvent } from "dacci-nostr-nips";
import {
  createEffect,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { restoreSession, useAuth } from "./auth.jsx";
import { fetchEventById, lookupEvent } from "./event-cache.js";
import {
  closeCompose,
  composeBusy,
  composeError,
  composeMode,
  composeOpen,
  composeTarget,
  openNewPost,
  submitCompose,
  type ComposeMode,
} from "./compose.js";
import { HomeTimeline } from "./components/HomeTimeline.jsx";
import { ProfileAvatar, ProfileName } from "./components/ProfileAvatar.jsx";
import { RelayDebugPanel } from "./components/RelayPanel.jsx";
import { NetworkView } from "./components/NetworkView.jsx";
import {
  NotificationsView,
  ProfileView,
  SettingsView,
} from "./components/Views.jsx";
import { getConnection } from "./nostr.js";
import { noticeMessage } from "./notice.js";
import { resetHomeFeed } from "./home-feed.js";
import { adoptMyActivity, syncMyActivity } from "./my-actions.js";
import { resetNotifications } from "./notifications-feed.js";
import { resetProfiles } from "./profile.js";
import { startLiveFeeds } from "./live.js";
import {
  initRelays,
  startAutoRefresh,
  stopAutoRefresh,
  useFeed,
  useRelays,
} from "./relays.js";
import {
  currentHash,
  goBackOrHome,
  navigate,
  parseHash,
  subscribeRoute,
  type Menu,
  type Route,
} from "./router.js";

const COMPOSE_TITLES: Record<ComposeMode, string> = {
  new: "新規投稿",
  reply: "リプライ",
  quote: "引用付きリポスト",
};

const MENU_LABELS: Array<{ menu: Menu; label: string }> = [
  { menu: "home", label: "Home" },
  { menu: "notifications", label: "Notification" },
  { menu: "network", label: "Network" },
  { menu: "profile", label: "Profile" },
  { menu: "settings", label: "Settings" },
];

export function App() {
  const [route, setRoute] = createSignal<Route>(parseHash(currentHash()));
  const { menuRoute, eventRoute } = projectRoute(route);
  const [draft, setDraft] = createSignal("");
  const { pubkey } = useAuth();
  const { readRelays, relayVersion } = useRelays();
  const { feedAuthors } = useFeed();
  const selfPubkey = (): string | undefined => pubkey() ?? undefined;
  const liveDeps = {
    readRelays,
    feedAuthors,
    selfPubkey,
  };
  let stopLiveFeeds: () => void = () => {};
  let liveKey = "";

  // Restore the persisted set first so personal relays survive reloads,
  // then restore the login session on top. Live status refresh runs on.
  onMount(() => {
    initRelays();
    void restoreSession();
    const stopRefresh = startAutoRefresh();
    // Live feeds live at app level: switching pages must not stop them.
    const stopLive = startLiveFeeds(liveDeps);
    stopLiveFeeds = stopLive;
    // A missing hash lands on home so the URL always reflects the view.
    if (currentHash() === "") navigate("#/home");
    const unsubscribe = subscribeRoute(() => setRoute(parseHash(currentHash())));
    onCleanup(() => {
      stopRefresh();
      stopLive();
      unsubscribe();
    });
  });

  // A new relay set can answer metadata queries the old one could not, so
  // the profile cache and its failed-user queue start over with it.
  createEffect(() => {
    relayVersion();
    untrack(resetProfiles);
  });

  // Login, logout, a new relay set or a new feed filter: rebuild the
  // streams so the buffers always match what is on screen.
  createEffect(() => {
    const key = `${pubkey() ?? ""}|${relayVersion()}|${JSON.stringify(feedAuthors() ?? [])}`;
    if (key === liveKey) return;
    liveKey = key;
    untrack(() => {
      stopLiveFeeds();
      stopLiveFeeds = startLiveFeeds(liveDeps);
      // The paginated lists belong to the same identity: reset them only
      // when it really changed, never just because the view remounted.
      resetHomeFeed();
      resetNotifications();
      // Action highlights are personal, and the relays are the source of
      // truth for what this key has already done.
      adoptMyActivity(pubkey());
      if (pubkey() !== null) void syncMyActivity();
    });
  });

  function openMenu(menu: Menu): void {
    navigate(`#/${menu}`);
  }

  function openDetail(event: NostrEvent): void {
    navigate(`#/event/${event.id}`);
  }

  async function publish(): Promise<void> {
    const sent = await submitCompose(draft());
    if (sent) setDraft("");
  }

  return (
    <div class="mx-auto flex min-h-screen max-w-6xl">
      {/* Menu (fixed) */}
      <nav class="sticky top-0 h-screen w-48 shrink-0 overflow-y-auto border-r border-(--dads-solid-gray-200) p-3">
        <h1 class="px-2 py-2 text-xl font-bold text-(--dads-blue-700)">Dacci</h1>
        <ul>
          <For each={MENU_LABELS}>
            {(item) => (
              <li>
                <button
                  class="w-full rounded-2xl px-3 py-2 text-left hover:bg-(--dads-blue-50)"
                  classList={{
                    "bg-(--dads-blue-50) font-bold": isMenuActive(
                      route(),
                      item.menu,
                    ),
                  }}
                  onClick={() => openMenu(item.menu)}
                >
                  {item.label}
                </button>
              </li>
            )}
          </For>
        </ul>
        <button
          class="mt-3 w-full rounded-2xl bg-(--dads-blue-700) px-3 py-2 text-white"
          onClick={openNewPost}
        >
          Compose
        </button>
      </nav>

      {/* Main column: page scrolls the window, so the scrollbar sits at the window edge */}
      <main class="min-w-0 flex-1 border-r border-(--dads-solid-gray-200)">
        <Switch>
          <Match when={menuRoute()}>
            {(menu) => <MenuContent menu={menu()} onSelect={openDetail} />}
          </Match>
          <Match when={eventRoute()}>
            {(detail) => (
              <EventDetailView eventId={detail()} urls={readRelays()} />
            )}
          </Match>
        </Switch>
      </main>

      {/* Reserved sidebar (fixed): relay debug panel */}
      <aside class="sticky top-0 hidden h-screen w-72 shrink-0 overflow-y-auto p-4 md:block">
        <RelayDebugPanel />
      </aside>

      {/* Compose modal: a new note, a reply or a quote repost */}
      <Show when={composeOpen()}>
        <div class="fixed inset-0 flex items-center justify-center bg-black/40">
          <div class="w-full max-w-md rounded-2xl bg-white p-4">
            <h2 class="font-bold">{COMPOSE_TITLES[composeMode()]}</h2>
            <Show when={composeTarget()}>
              {(event) => (
                <div class="mt-2 flex gap-2 rounded-2xl bg-(--dads-solid-gray-100) p-2">
                  <ProfileAvatar pubkey={event().pubkey} size={28} />
                  <div class="min-w-0">
                    <ProfileName pubkey={event().pubkey} class="text-sm" />
                    <p class="line-clamp-3 text-xs break-words text-(--dads-solid-gray-700)">
                      {event().content}
                    </p>
                  </div>
                </div>
              )}
            </Show>
            <textarea
              class="mt-2 h-32 w-full rounded-2xl border border-(--dads-solid-gray-300) p-2"
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
            />
            <p class="mt-1 text-sm text-(--dads-solid-gray-500)">
              <Show
                when={pubkey()}
                fallback={"投稿にはログインが必要です (Settings) 。"}
              >
                {"投稿は接続中のリレーへ公開されます。"}
              </Show>
            </p>
            <Show when={composeError()}>
              <p class="mt-1 text-sm text-(--dads-red-600)">{composeError()}</p>
            </Show>
            <div class="mt-3 flex justify-end gap-2">
              <button
                class="rounded-2xl border border-(--dads-solid-gray-300) px-4 py-2"
                onClick={closeCompose}
              >
                閉じる
              </button>
              <button
                class="rounded-2xl bg-(--dads-blue-700) px-4 py-2 text-white disabled:opacity-50"
                disabled={
                  pubkey() === null ||
                  draft().trim() === "" ||
                  composeBusy()
                }
                onClick={() => void publish()}
              >
                {composeBusy()
                  ? "送信中…"
                  : composeMode() === "quote"
                    ? "引用投稿"
                    : composeMode() === "reply"
                      ? "リプライ"
                      : "投稿"}
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Transient confirmation for repost and reaction */}
      <Show when={noticeMessage()}>
        <p class="pointer-events-none fixed bottom-6 left-1/2 z-30 -translate-x-1/2 rounded-full bg-(--dads-solid-gray-800) px-4 py-2 text-sm text-white">
          {noticeMessage()}
        </p>
      </Show>
    </div>
  );
}

function isMenuActive(route: Route, menu: Menu): boolean {
  return route.name === "menu" && route.menu === menu;
}

// Match needs accessors, so the discriminated union is projected into
// two optional accessors that narrow cleanly under TS.
function projectRoute(route: () => Route): {
  menuRoute: () => Menu | undefined;
  eventRoute: () => string | undefined;
} {
  return {
    menuRoute: () => {
      const current = route();
      return current.name === "menu" ? current.menu : undefined;
    },
    eventRoute: () => {
      const current = route();
      return current.name === "event" ? current.eventId : undefined;
    },
  };
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
        <NotificationsView onSelect={props.onSelect} />
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

function EventDetailView(props: { eventId: string; urls: string[] }) {
  const initial = lookupEvent(props.eventId);
  const [event, setEvent] = createSignal<NostrEvent | null>(initial);
  const [loading, setLoading] = createSignal(initial === null);

  async function resolve(id: string): Promise<void> {
    const cached = lookupEvent(id);
    if (cached !== null) {
      setEvent(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    const found = await fetchEventById(id, props.urls, (url, f) =>
      getConnection(url)
        .query(f, 6000)
        .then((r) => (r.failed ? [] : r.events)),
    );
    // Ignore a completion for an id the user already navigated away from.
    if (untrack(() => props.eventId) !== id) return;
    setEvent(found);
    setLoading(false);
  }

  // Re-resolves when the route id changes (deep links, direct navigation).
  createEffect(() => {
    const id = props.eventId;
    if (id === "") return;
    void resolve(id);
  });

  return (
    <div>
      <button
        class="m-3 rounded-2xl border border-(--dads-solid-gray-300) px-3 py-1"
        onClick={goBackOrHome}
      >
        ← 戻る
      </button>
      <Show when={loading()}>
        <p class="px-4 py-6 text-(--dads-solid-gray-500)">読み込み中…</p>
      </Show>
      <Show
        when={event() ?? null}
        fallback={
          <p class="px-4 py-6 text-(--dads-solid-gray-500)">
            イベントを取得できませんでした (削除済み、またはリレーに存在しません)。
          </p>
        }
      >
        {(found) => <ProfileView event={found()} />}
      </Show>
    </div>
  );
}
