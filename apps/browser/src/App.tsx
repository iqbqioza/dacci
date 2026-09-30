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
import { getSigner, restoreSession, useAuth } from "./auth.jsx";
import { fetchEventById, lookupEvent } from "./event-cache.js";
import { HomeTimeline } from "./components/HomeTimeline.jsx";
import { RelayDebugPanel } from "./components/RelayPanel.jsx";
import {
  NetworkView,
  NotificationsView,
  ProfileView,
  SettingsView,
} from "./components/Views.jsx";
import { getConnection } from "./nostr.js";
import { resetHomeFeed } from "./home-feed.js";
import { resetNotifications } from "./notifications-feed.js";
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
  const [composeOpen, setComposeOpen] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [publishing, setPublishing] = createSignal(false);
  const [publishError, setPublishError] = createSignal<string | null>(null);
  const { pubkey } = useAuth();
  const { relayUrls, relayVersion } = useRelays();
  const { feedAuthors } = useFeed();
  const selfPubkey = (): string | undefined => pubkey() ?? undefined;
  const liveDeps = {
    relayUrls,
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
    });
  });

  function openMenu(menu: Menu): void {
    navigate(`#/${menu}`);
  }

  function openDetail(event: NostrEvent): void {
    navigate(`#/event/${event.id}`);
  }

  async function publish(): Promise<void> {
    const signer = getSigner();
    const key = pubkey();
    const content = draft().trim();
    if (signer === null || key === null || content === "") return;
    setPublishing(true);
    setPublishError(null);
    try {
      const event = await signer.signEvent({
        pubkey: key,
        created_at: Math.floor(Date.now() / 1000),
        kind: 1,
        tags: [],
        content,
      });
      const result = await getConnection(relayUrls()[0]).publish(event);
      if (result.accepted) {
        setDraft("");
        setComposeOpen(false);
      } else {
        setPublishError(`投稿が拒否されました: ${result.message}`);
      }
    } catch (error) {
      setPublishError(
        error instanceof Error ? error.message : "投稿に失敗しました",
      );
    } finally {
      setPublishing(false);
    }
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
          onClick={() => setComposeOpen(true)}
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
              <EventDetailView eventId={detail()} urls={relayUrls()} />
            )}
          </Match>
        </Switch>
      </main>

      {/* Reserved sidebar (fixed): relay debug panel */}
      <aside class="sticky top-0 hidden h-screen w-72 shrink-0 overflow-y-auto p-4 md:block">
        <RelayDebugPanel />
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
              <Show
                when={pubkey()}
                fallback={"投稿にはログインが必要です (Settings) 。"}
              >
                {"投稿はテスト用リレーに公開されます。"}
              </Show>
            </p>
            <Show when={publishError()}>
              <p class="mt-1 text-sm text-(--dads-red-600)">{publishError()}</p>
            </Show>
            <div class="mt-3 flex justify-end gap-2">
              <button
                class="rounded-2xl border border-(--dads-solid-gray-300) px-4 py-2"
                onClick={() => setComposeOpen(false)}
              >
                閉じる
              </button>
              <button
                class="rounded-2xl bg-(--dads-blue-700) px-4 py-2 text-white disabled:opacity-50"
                disabled={
                  pubkey() === null ||
                  draft().trim() === "" ||
                  publishing()
                }
                onClick={() => void publish()}
              >
                {publishing() ? "投稿中…" : "投稿"}
              </button>
            </div>
          </div>
        </div>
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
