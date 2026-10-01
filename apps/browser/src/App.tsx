import type { NostrEvent } from "dacci-nostr-nips";
import { displayContent } from "dacci-nostr-nips";
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
import { resetEmbeds } from "./embeds.js";
import { createDetail } from "./detail.js";
import { fetchEventById } from "./event-cache.js";
import {
  closeCompose,
  composeBusy,
  composeError,
  composeMode,
  composeOpen,
  composeTarget,
  openNewPost,
  publishReply,
  replyFailureText,
  submitCompose,
  type ComposeMode,
} from "./compose.js";
import { HomeTimeline } from "./components/HomeTimeline.jsx";
import { ProfileAvatar, ProfileName } from "./components/ProfileAvatar.jsx";
import { RelayDebugPanel } from "./components/RelayPanel.jsx";
import { NetworkView } from "./components/NetworkView.jsx";
import { EventCard } from "./components/EventCard.jsx";
import { ProfilePage } from "./components/ProfilePage.jsx";
import { UploadPicker } from "./components/UploadPicker.jsx";
import { NotificationsView, SettingsView } from "./components/Views.jsx";
import { getConnection } from "./nostr.js";
import { noticeMessage } from "./notice.js";
import { resetHomeFeed } from "./home-feed.js";
import { resetFollowCounts } from "./follows.js";
import { startLiveFeeds, watchProfileSubject } from "./live.js";
import { adoptMyActivity, syncMyActivity } from "./my-actions.js";
import { resetNotifications } from "./notifications-feed.js";
import { resetProfileFeed, openProfile } from "./profile-feed.js";
import { resetProfiles } from "./profile.js";
import { addReply, loadReplies, resetReplies, useReplies } from "./replies-feed.js";
import { loadServers } from "./servers.js";
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

/** What the profile page should show: a pubkey, or the reader's own. */
interface ProfileTarget {
  pubkey: string | null;
  invalid: boolean;
}

const COMPOSE_TITLES: Record<ComposeMode, string> = {
  new: "新規投稿",
  reply: "リプライ",
  quote: "引用付きリポスト",
};

const MENU_LABELS: Array<{ menu: Menu; label: string }> = [
  { menu: "home", label: "Home" },
  { menu: "notifications", label: "Notification" },
  { menu: "network", label: "Network" },
  { menu: "settings", label: "Settings" },
];

export function App() {
  const [route, setRoute] = createSignal<Route>(parseHash(currentHash()));
  const { menuRoute, eventRoute, profileRoute, profileTarget, repliesRoute } =
    projectRoute(route);
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
  /** Whose server list is loaded, so it is read again only on a change. */
  let serversIdentity = "";

  // Restore the persisted set first so personal relays survive reloads,
  // then restore the login session on top. Live status refresh runs on.
  onMount(() => {
    initRelays();
    // The upload servers are the reader's own settings and live on the
    // account, so they are read only once the session is known: asking
    // before the restore finished would query as a signed-out reader and
    // quietly fall back to the defaults.
    void restoreSession().then(() => loadServers());
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
  // the profile cache and its failed-user queue start over with it. The
  // embedded notes and the replies come from the same relays, so they
  // start over too.
  createEffect(() => {
    relayVersion();
    untrack(() => {
      resetProfiles();
      resetFollowCounts();
      resetProfileFeed();
      resetEmbeds();
      resetReplies();
    });
  });

  // The profile page follows whoever it is showing, live. Leaving the page
  // only stops the stream: the loaded posts stay for the next visit.
  createEffect(() => {
    const target = profileTarget();
    if (target === undefined || target.invalid) {
      // Off the profile page, or a broken link: stop the stream and keep
      // whatever was already loaded.
      watchProfileSubject(null);
      return;
    }
    // The reader's own profile page carries no pubkey in the URL.
    const subject = target.pubkey ?? pubkey() ?? null;
    watchProfileSubject(subject);
    untrack(() => openProfile(subject));
  });

  // Login, logout, a new relay set or a new feed filter: rebuild the
  // streams so the buffers always match what is on screen.
  createEffect(() => {
    const key = `${pubkey() ?? ""}|${relayVersion()}|${JSON.stringify(feedAuthors() ?? [])}`;
    if (key === liveKey) return;
    liveKey = key;
    // A login or logout changes whose servers these are, so they are read
    // again. A relay change on its own does not: the same list still
    // applies, and the startup read already covered the first pass.
    const identity = `${pubkey() ?? ""}`;
    if (identity !== serversIdentity) {
      serversIdentity = identity;
      untrack(() => void loadServers());
    }
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
            {(menu) => (
              <MenuContent
                menu={menu()}
                replies={repliesRoute()}
                onSelect={openDetail}
              />
            )}
          </Match>
          {/* Match needs an accessor to hand the target to the page. */}
          <Match when={profileTarget()}>
            {(target) => (
              <ProfilePage
                pubkey={target().pubkey}
                invalid={target().invalid}
                replies={repliesRoute()}
                onSelect={openDetail}
              />
            )}
          </Match>
          <Match when={eventRoute()}>
            {(detail) => (
              <EventDetailView
                eventId={detail()}
                urls={readRelays()}
                onSelect={openDetail}
              />
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
                      {displayContent(event())}
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
// optional accessors that narrow cleanly under TS.
function projectRoute(route: () => Route): {
  menuRoute: () => Menu | undefined;
  eventRoute: () => string | undefined;
  /** True while the URL asks for the Replies and notes tab. */
  repliesRoute: () => boolean;
  /** Pubkey of the profile being shown; null means the reader's own. */
  profileRoute: () => string | null | undefined;
  /** The whole profile target, or undefined off the profile page. */
  profileTarget: () => ProfileTarget | undefined;
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
    repliesRoute: () => {
      const current = route();
      // An event page has no tabs, so it reports the default.
      return current.name !== "event" && current.replies;
    },
    profileRoute: () => {
      const current = route();
      return current.name === "profile" ? current.pubkey : undefined;
    },
    profileTarget: () => {
      const current = route();
      return current.name === "profile"
        ? { pubkey: current.pubkey, invalid: current.invalid }
        : undefined;
    },
  };
}

function MenuContent(props: {
  menu: Menu;
  /** The tab the URL selects. */
  replies: boolean;
  onSelect: (event: NostrEvent) => void;
}) {
  return (
    <Switch>
      <Match when={props.menu === "home"}>
        <HomeTimeline replies={props.replies} onSelect={props.onSelect} />
      </Match>
      <Match when={props.menu === "notifications"}>
        <NotificationsView onSelect={props.onSelect} />
      </Match>
      <Match when={props.menu === "network"}>
        <NetworkView />
      </Match>
      <Match when={props.menu === "settings"}>
        <SettingsView />
      </Match>
    </Switch>
  );
}

/**
 * One post on its own page. The profile page already exists, so nothing of
 * the author's profile is repeated here: this view is the post, the quote it
 * carries, and the actions a reader can take on it.
 */
function EventDetailView(props: {
  eventId: string;
  urls: string[];
  /** Opens a post, so a reply in the list can be read on its own page. */
  onSelect: (event: NostrEvent) => void;
}) {
  // The store lives at module level so a deep link opened from a feed shows
  // the post at once, with no request, and the detail page keeps it.
  const detail = createDetail(
    (id) =>
      fetchEventById(id, untrack(() => props.urls), (url, f) =>
        getConnection(url)
          .query(f, 6000)
          .then((r) => (r.failed ? [] : r.events)),
      ),
  );

  // Re-resolves when the route id changes (deep links, direct navigation).
  createEffect(() => {
    const id = props.eventId;
    if (id === "") return;
    void detail.resolve(id, () => untrack(() => props.eventId) === id);
  });

  // The answers are looked up under the post being shown, so the list always
  // belongs to the post on screen.
  const replyState = () => useReplies(props.eventId);

  createEffect(() => {
    const found = detail.event();
    if (found === null) return;
    void loadReplies(found.id);
  });

  return (
    <div>
      {/* The bar is pinned so a long post can be left without hunting for
          the way back, and it carries the id a shared link is built from. */}
      <div class="sticky top-0 z-20 flex items-center gap-2 border-b border-(--dads-solid-gray-200) bg-white px-3 py-2">
        <button
          class="shrink-0 rounded-2xl border border-(--dads-solid-gray-300) px-3 py-1 hover:bg-(--dads-blue-50)"
          onClick={goBackOrHome}
        >
          ← 戻る
        </button>
        <span class="truncate font-mono text-xs text-(--dads-solid-gray-500)">
          {props.eventId}
        </span>
      </div>
      <Show when={detail.loading()}>
        <p class="px-4 py-6 text-(--dads-solid-gray-500)">読み込み中…</p>
      </Show>
      <Show when={detail.failed()}>
        <p class="px-4 py-6 text-(--dads-solid-gray-500)">
          イベントを取得できませんでした (削除済み、またはリレーに存在しません)。
        </p>
      </Show>
      <Show when={detail.event() ?? null}>
        {(found) => (
          <EventCard event={found()} onSelect={() => undefined} detailed />
        )}
      </Show>
      {/* The direct answers, in the same card a feed uses, so a reply reads
          exactly as it would anywhere else in the app. */}
      <Show when={detail.event() ?? null} keyed>
        {(found) => (
          <RepliesOf
            postId={found.id}
            target={found}
            onSelect={props.onSelect}
          />
        )}
      </Show>
    </div>
  );
}

/**
 * The reply box under a post, with the image picker beside it. It replaces a
 * heading here because a reader looking at a conversation is usually the one
 * about to join it, and the answers are listed right below, so a count beside
 * the box would only repeat what the list already shows.
 */
function ReplyForm(props: { target: NostrEvent }) {
  const { pubkey } = useAuth();
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // The caret is kept so an uploaded url lands where the reader was typing,
  // not at the end of the text they have since moved away from.
  let input: HTMLTextAreaElement | undefined;

  /** Inserts text at the caret, or at the end when there is no caret. */
  function insertAtCaret(text: string): void {
    const el = input;
    if (el === undefined) {
      setDraft((prev) => (prev === "" ? text : `${prev}\n${text}`));
      return;
    }
    const at = el.selectionStart ?? el.value.length;
    const next = `${el.value.slice(0, at)}${text}${el.value.slice(at)}`;
    setDraft(next);
    // The value is set by the signal, so the caret has to be moved after the
    // DOM catches up, or it would jump back to where it was.
    queueMicrotask(() => {
      const caret = at + text.length;
      el.setSelectionRange(caret, caret);
      el.focus();
    });
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy() || draft().trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const result = await publishReply(props.target, draft());
      if ("failure" in result) {
        setError(replyFailureText(result.failure));
        return;
      }
      // Show it straight away rather than waiting for a relay to echo it.
      addReply(result.sent);
      setDraft("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "送信に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      class="border-b border-(--dads-solid-gray-200) px-4 py-3"
      onSubmit={(e) => void submit(e)}
    >
      <textarea
        ref={input}
        class="w-full rounded-2xl border border-(--dads-solid-gray-300) p-2"
        rows={2}
        placeholder={
          pubkey() === null
            ? "リプライするにはログインしてください (Settings)"
            : "リプライを入力"
        }
        disabled={pubkey() === null || busy()}
        value={draft()}
        onInput={(e) => setDraft(e.currentTarget.value)}
      />
      <div class="mt-2 flex items-center justify-between gap-2">
        <UploadPicker
          canUpload={pubkey() !== null}
          onUploaded={insertAtCaret}
          onError={setError}
        />
        <button
          type="submit"
          class="rounded-2xl bg-(--dads-blue-700) px-4 py-1.5 text-sm text-white disabled:opacity-50"
          disabled={pubkey() === null || busy() || draft().trim() === ""}
        >
          {busy() ? "送信中…" : "リプライ"}
        </button>
      </div>
      <Show when={error()}>
        {(message) => (
          <p class="mt-1 text-sm text-(--dads-red-600)">{message()}</p>
        )}
      </Show>
    </form>
  );
}

function RepliesOf(props: {
  postId: string;
  /** The post being answered, which the form replies to. */
  target: NostrEvent;
  onSelect: (event: NostrEvent) => void;
}) {
  const state = () => useReplies(props.postId);
  const answers = () => state().events();

  return (
    <section>
      {/* The post above closes with its own rule, so the form below opens
          the conversation with one of its own. */}
      <ReplyForm target={props.target} />
      <Show when={state().loading()}>
        <p class="px-4 py-4 text-(--dads-solid-gray-500)">リプライを読み込み中…</p>
      </Show>
      <Show when={!state().loading() && state().searched() && answers().length === 0}>
        <p class="px-4 py-4 text-(--dads-solid-gray-500)">
          この投稿へのリプライはまだありません。
        </p>
      </Show>
      <For each={answers()}>
        {(event) => <EventCard event={event} onSelect={props.onSelect} />}
      </For>
    </section>
  );
}
