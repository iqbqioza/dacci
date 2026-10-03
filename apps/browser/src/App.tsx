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
import { trapFocus } from "./focus-trap.js";
import { createDetail } from "./detail.js";
import { answerEvents, fetchEventById } from "./event-cache.js";
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
import { PageBar } from "./components/PageBar.jsx";
import { EventCard } from "./components/EventCard.jsx";
import { ProfilePage } from "./components/ProfilePage.jsx";
import { UploadPicker } from "./components/UploadPicker.jsx";
import {
  NotificationArrivals,
  NotificationsView,
  SettingsView,
} from "./components/Views.jsx";
import { getConnection } from "./nostr.js";
import { noticeMessage } from "./notice.js";
import { resetHomeFeed } from "./home-feed.js";
import { resetFollowCounts } from "./follows.js";
import { requestMyFollows, resetMyFollows } from "./my-follows.js";
import { resetDeleted, syncDeleted, isDeleted } from "./deleted.js";
import { requestMyMutes, resetMyMutes } from "./muted.js";
import { startLiveFeeds, watchProfileSubject } from "./live.js";
import { adoptMyActivity, syncMyActivity } from "./my-actions.js";
import { ensureNotifications, resetNotifications, useNotifications } from "./notifications-feed.js";
import { resetProfileFeed, openProfile } from "./profile-feed.js";
import { resetProfiles } from "./profile.js";
import { ProfileEditor } from "./components/ProfileEditor.jsx";
import { SensitiveBody } from "./components/SensitiveBody.jsx";
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
  profileHash,
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

/**
 * The menu, in the order it is shown. Profile sits with the other personal
 * views rather than in a list of feeds, because it opens a profile page: the
 * reader's own is addressed the same way anyone else's is, so a link copied
 * out of the address bar works for whoever opens it.
 */
type MenuItem = { label: string; menu: Menu } | { label: string; profile: true };

const MENU_ITEMS: MenuItem[] = [
  { label: "Home", menu: "home" },
  { label: "Notification", menu: "notifications" },
  { label: "Profile", profile: true },
  { label: "Network", menu: "network" },
  { label: "Settings", menu: "settings" },
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
  /** The compose dialog's own textarea, so focus can be placed inside it. */
  let composeInput: HTMLTextAreaElement | undefined;
  /** The compose dialog itself, so the keyboard can be held inside it. */
  let composePanel: HTMLDivElement | undefined;
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
      // The reader's own follow list is read from these relays too, and it is
      // the only place a follow can be published from, so it starts over.
      resetMyFollows();
      // Their mute list is one of those lists.
      resetMyMutes();
      resetProfileFeed();
      resetEmbeds();
      resetReplies();
    });
  });

  // Escape is the way out of anything that asks, and every other dialog in the
  // app offers it. This one did not, which left a keyboard with no way out but
  // hunting for the close button. Focus also has to come inside: without it the
  // first Tab press carries on from the button behind the scrim, into the feed
  // the dialog is covering.
  createEffect(() => {
    if (!composeOpen()) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeCompose();
    };
    document.addEventListener("keydown", onKey);
    // And has to stay inside. `aria-modal="true"` says the timeline behind the
    // scrim cannot be reached, and nothing made it so: a Tab past the last
    // control walked the feed under the scrim, one article at a time.
    const untrap =
      composePanel === undefined ? () => undefined : trapFocus(composePanel);
    // Where the reader was, to hand back when the dialog closes. The dialog is
    // mounted at the app's top level and outlives the route behind it, so this is
    // the Compose button in the nav — which a route change can still take away.
    const before = document.activeElement;
    // The dialog is not in the DOM until this effect runs, so the caret waits
    // for the next tick before it is placed inside it.
    queueMicrotask(() => {
      composeInput?.focus();
    });
    onCleanup(() => {
      document.removeEventListener("keydown", onKey);
      untrap();
      // Without this, dismissing the dialog left the reader on the body and their
      // next Tab restarted at the top of the page. `focus()` on a detached element
      // is a silent no-op, so the page itself is the fallback.
      if (
        before instanceof HTMLElement &&
        before !== document.body &&
        before.isConnected
      ) {
        before.focus();
        return;
      }
      const main = document.querySelector<HTMLElement>("main");
      if (main === null) return;
      if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
      main.focus();
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
      const self = pubkey();
      // Re-establish whose notifications these are, in the same breath as the
      // reset above. The view re-asserts it too, but effect order between here
      // and there is not defined — and the reset was observed winning last on
      // boot, which left the page permanently empty: no list, no bar, until
      // the reader navigated away and back. Owning both halves here makes the
      // outcome independent of that order.
      if (self !== null) ensureNotifications(self);
      adoptMyActivity(self);
      // The deleted set belongs to whoever is reading now, so a new reader
      // starts from an empty one instead of inheriting the last one's.
      resetDeleted();
      if (self !== null) {
        void syncMyActivity();
        // The reader's own deletions decide what a feed does not show, so they
        // are read back from the same relays on the same login.
        void syncDeleted(self);
        // So does their NIP-51 mute list.
        requestMyMutes();
      }
      // The follow button reads the reader's own kind 3, which is only asked
      // for once a session, so the first profile that shows one asks for it.
      if (pubkey() !== null) requestMyFollows();
    });
  });

  function openMenu(menu: Menu): void {
    navigate(`#/${menu}`);
  }

  /**
   * The reader's own profile. A session gives a pubkey to name it by, so the
   * URL is the same `#/profile/<pubkey>` the feed links to for anyone else;
   * without one there is nothing to put there, and the short form says to
   * sign in instead.
   */
  function openSelfProfile(): void {
    const self = pubkey();
    navigate(self === null ? "#/profile" : profileHash(self));
  }

  function openItem(item: MenuItem): void {
    if ("profile" in item) {
      openSelfProfile();
      return;
    }
    openMenu(item.menu);
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
      <nav class="sticky top-0 h-screen w-48 shrink-0 overflow-y-auto border-r border-(--line) p-3">
        <h1 class="px-2 py-2 text-xl font-bold text-(--accent)">Dacci</h1>
        <ul>
          <For each={MENU_ITEMS}>
            {(item) => (
              <li>
                <button
                  class="w-full rounded-2xl px-3 py-2 text-left hover:bg-(--accent-soft)"
                  classList={{
                    "bg-(--accent-soft) font-bold": isItemActive(route(), item),
                  }}
                  onClick={() => openItem(item)}
                >
                  {item.label}
                </button>
              </li>
            )}
          </For>
        </ul>
        <button
          class="mt-3 w-full rounded-2xl bg-(--accent) px-3 py-2 text-(--on-accent)"
          onClick={openNewPost}
        >
          Compose
        </button>
      </nav>

      {/* Main column: page scrolls the window, so the scrollbar sits at the window edge */}
      <main class="min-w-0 flex-1 border-r border-(--line)">
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
        {/* Above every pinned bar. A scroll-pinned row is a stacking context
            of its own, so a scrim without a z-index of its own paints under
            them and leaves the page behind it clickable while it is open. */}
        <div
          class="fixed inset-0 z-50 flex items-center justify-center bg-(--scrim)"
          onClick={closeCompose}
        >
          <div
            ref={(el) => {
              composePanel = el;
            }}
            class="w-full max-w-md rounded-2xl bg-(--surface) p-4"
            role="dialog"
            aria-modal="true"
            aria-label={COMPOSE_TITLES[composeMode()]}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 class="font-bold">{COMPOSE_TITLES[composeMode()]}</h2>
            <Show when={composeTarget()}>
              {(event) => (
                <div class="mt-2 flex gap-2 rounded-2xl bg-(--fill-soft) p-2">
                  <ProfileAvatar pubkey={event().pubkey} size={28} />
                  <div class="min-w-0">
                    <ProfileName pubkey={event().pubkey} class="text-sm" />
                    {/* The target's body goes through the same gate as the
                        card it came from. It used to be rendered raw, so a
                        reader who chose not to have sensitive text in the
                        document at all still got it — selectable and copyable —
                        the moment they opened the reply box. `line-clamp` is a
                        visual clamp; the text underneath it was always there. */}
                    <SensitiveBody event={event()}>
                      <p class="line-clamp-3 text-xs break-words text-(--ink-muted)">
                        {displayContent(event())}
                      </p>
                    </SensitiveBody>
                  </div>
                </div>
              )}
            </Show>
            <textarea
              ref={(el) => {
                composeInput = el;
              }}
              // A placeholder is not a name: a screen reader announces a bare
              // field as "edit text" with nothing saying what goes in it.
              aria-label="投稿の内容"
              class="mt-2 h-32 w-full rounded-2xl border border-(--line-strong) p-2"
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
            />
            <p class="mt-1 text-sm text-(--ink-muted)">
              <Show
                when={pubkey()}
                fallback={"投稿にはログインが必要です (Settings) 。"}
              >
                {"投稿は接続中のリレーへ公開されます。"}
              </Show>
            </p>
            <Show when={composeError()}>
              <p class="mt-1 text-sm text-(--danger)">{composeError()}</p>
            </Show>
            <div class="mt-3 flex justify-end gap-2">
              <button
                class="rounded-2xl border border-(--line-strong) px-4 py-2"
                onClick={closeCompose}
              >
                閉じる
              </button>
              <button
                class="rounded-2xl bg-(--accent) px-4 py-2 text-(--on-accent) disabled:opacity-50"
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

      {/* Profile editor: the reader's own NIP-01 metadata */}
      <ProfileEditor />

      {/* Transient confirmation for an action with no visible result */}
      <Show when={noticeMessage()}>
        <p class="pointer-events-none fixed bottom-6 left-1/2 z-30 -translate-x-1/2 rounded-full bg-(--chip) px-4 py-2 text-sm text-(--on-chip)">
          {noticeMessage()}
        </p>
      </Show>
    </div>
  );
}

function isMenuActive(route: Route, menu: Menu): boolean {
  return route.name === "menu" && route.menu === menu;
}

/**
 * True while the item is what the URL is showing. The profile item is lit for
 * any profile page, since the menu has no way to say whose profile it opened.
 */
function isItemActive(route: Route, item: MenuItem): boolean {
  return "profile" in item ? route.name === "profile" : isMenuActive(route, item.menu);
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

/**
 * A feed or a page from the menu. Home is the app itself, so it has no bar and
 * nowhere to go back to. Every other page carries one, the way a note and a
 * profile do, and names itself there so the address can be copied from
 * wherever the reader is.
 */
function MenuContent(props: {
  menu: Menu;
  /** The tab the URL selects. */
  replies: boolean;
  onSelect: (event: NostrEvent) => void;
}) {
  return (
    <Show
      when={props.menu === "home" ? null : props.menu}
      fallback={<HomeTimeline replies={props.replies} onSelect={props.onSelect} />}
    >
      {(menu) => (
        <div>
          {/* Notifications pin a second row under the page bar, so the two share
              one sticky container: two bars at `top-0` means the one painted
              later hides the other, which made `← 戻る` unreachable for as long
              as anything had arrived. */}
          <Show
            when={menu() === "notifications"}
            fallback={<PageBar id={`#/${menu()}`} />}
          >
            <div
              ref={useNotifications().setHeaderRef}
              class="sticky top-0 z-30 bg-(--surface)"
            >
              <PageBar id={`#/${menu()}`} />
              <NotificationArrivals />
            </div>
          </Show>
          <Switch>
            <Match when={menu() === "notifications"}>
              <NotificationsView onSelect={props.onSelect} />
            </Match>
            <Match when={menu() === "network"}>
              <NetworkView />
            </Match>
            <Match when={menu() === "settings"}>
              <SettingsView />
            </Match>
          </Switch>
        </div>
      )}
    </Show>
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
      fetchEventById(id, untrack(() => props.urls), async (url, f) =>
        // `null` for a relay that gave no answer at all, so one that was closed
        // or timed out is not read as "this post does not exist".
        answerEvents(await getConnection(url).query(f, 6000)),
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
  // A deletion request is the reader's own, so the page knows it even when a
  // relay would still hand the post back.
  const gone = (): boolean => isDeleted(props.eventId);

  createEffect(() => {
    const found = detail.event();
    if (found === null) return;
    void loadReplies(found.id);
  });

  return (
    <div>
      {/* The bar is pinned so a long post can be left without hunting for
          the way back, and it carries the id a shared link is built from. */}
      <PageBar id={props.eventId} />
      <Show when={detail.loading()}>
        <p class="px-4 py-6 text-(--ink-muted)">読み込み中…</p>
      </Show>
      <Show when={detail.failed()}>
        <p class="px-4 py-6 text-(--ink-muted)">
          イベントを取得できませんでした (削除済み、またはリレーに存在しません)。
        </p>
      </Show>
      {/* A post the reader deleted is gone from the cache and from the feed, so
          its own page says so rather than showing it one more time. */}
      <Show when={gone()}>
        <p class="px-4 py-6 text-(--ink-muted)">
          この投稿は削除されました。
        </p>
      </Show>
      <Show when={gone() ? null : (detail.event() ?? null)}>
        {(found) => (
          <EventCard event={found()} onSelect={() => undefined} detailed />
        )}
      </Show>
      {/* The direct answers, in the same card a feed uses, so a reply reads
          exactly as it would anywhere else in the app. */}
      <Show when={gone() ? null : (detail.event() ?? null)} keyed>
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
      class="border-b border-(--line) px-4 py-3"
      onSubmit={(e) => void submit(e)}
    >
      <textarea
        ref={input}
        class="w-full rounded-2xl border border-(--line-strong) p-2"
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
          class="rounded-2xl bg-(--accent) px-4 py-1.5 text-sm text-(--on-accent) disabled:opacity-50"
          disabled={pubkey() === null || busy() || draft().trim() === ""}
        >
          {busy() ? "送信中…" : "リプライ"}
        </button>
      </div>
      <Show when={error()}>
        {(message) => (
          <p class="mt-1 text-sm text-(--danger)">{message()}</p>
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
        <p class="px-4 py-4 text-(--ink-muted)">リプライを読み込み中…</p>
      </Show>
      <Show when={!state().loading() && state().searched() && answers().length === 0}>
        <p class="px-4 py-4 text-(--ink-muted)">
          この投稿へのリプライはまだありません。
        </p>
      </Show>
      <For each={answers()}>
        {(event) => <EventCard event={event} onSelect={props.onSelect} />}
      </For>
    </section>
  );
}
