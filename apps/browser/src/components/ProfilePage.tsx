import type { NostrEvent } from "dacci-nostr-nips";
import { CONTACTS_KIND, encodeNpub, parseContacts } from "dacci-nostr-nips";
import { createEffect, For, onMount, Show, untrack } from "solid-js";
import { useAuth } from "../auth.jsx";
import { EventCard } from "./EventCard.jsx";
import { PageBar } from "./PageBar.jsx";
import { ProfileActions } from "./ProfileActions.jsx";
import { ProfileAvatar, ProfileName } from "./ProfileAvatar.jsx";
import { RichText } from "./RichText.jsx";
import { FeedTabs, type FeedTab } from "../feed-tabs.jsx";
import {
  flushProfileArrivals,
  loadMoreProfile,
  noteBarVisibility,
  openProfile,
  selectProfileTab,
  useProfileFeed,
} from "../profile-feed.js";
import { retryWhilePending } from "../feed-retry.js";
import { feedHash, navigate, profileHash } from "../router.js";
import { formatDate } from "../nostr.js";
import { useProfileLive } from "../live.js";
import { useProfile } from "../profile.js";
import { useFollowCount } from "../follows.js";

/** Twitter's profile header is 3:1, so the banner keeps that ratio. */
const BANNER_RATIO = "aspect-[3/1]";

/**
 * Profile header: banner, avatar, name, npub, bio and the follow count.
 * Twitter's proportions are kept, so a banner always reads the same way
 * whatever image the author chose.
 */
export function ProfileHeader(props: { pubkey: string }) {
  const profile = () => useProfile(props.pubkey).profile;
  const follows = useFollowCount(props.pubkey);
  const banner = () => profile()?.banner ?? null;
  const joined = (): string | null => {
    const at = profile()?.createdAt;
    return at === undefined ? null : formatDate(at);
  };

  return (
    <header class="border-b border-(--line)">
      <div class={`relative w-full overflow-hidden bg-(--fill) ${BANNER_RATIO}`}>
        <Show when={banner()}>
          {(url) => (
            <img
              src={url()}
              alt=""
              class="h-full w-full object-cover"
              loading="lazy"
              decoding="async"
              // The picture is on someone else's host, which has no business
              // knowing which profile, or which reader, pulled it.
              referrerpolicy="no-referrer"
            />
          )}
        </Show>
      </div>
      <div class="px-4 pb-3">
        {/* The avatar sits on the banner's edge, as on Twitter. It needs a
            stacking position, or the positioned banner would paint over it. */}
        <div class="relative z-10 -mt-16 mb-2 h-32 w-32">
          <ProfileAvatar
            pubkey={props.pubkey}
            size={128}
            class="rounded-full ring-4 ring-(--surface)"
          />
        </div>
        {/* The name takes the row it needs and the actions take the rest, so a
            long name wraps under the buttons rather than pushing them out of
            the header. The buttons are last so a touch on the name still reads
            as tapping the name. */}
        <div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-2">
          <div class="flex min-w-0 flex-wrap items-center gap-x-2">
            <span class="text-lg font-bold">
              <ProfileName pubkey={props.pubkey} />
            </span>
            <Show when={profile()?.nip05}>
              {(identifier) => (
                <span class="text-xs text-(--ink-quiet)">
                  {identifier()}
                </span>
              )}
            </Show>
          </div>
          <ProfileActions pubkey={props.pubkey} />
        </div>
        <p class="font-mono text-xs break-all text-(--ink-quiet)">
          {encodeNpub(props.pubkey) ?? props.pubkey}
        </p>
        {/* The bio is written by a person about themselves, so it reads the
            same way a post does: the people it names are shown by name, their
            custom emoji are drawn and the addresses in it are links. NIP-30
            says a profile's `name` and `about` are both emojified, and the
            name is drawn that way by `ProfileName`. */}
        <Show when={profile()?.about}>
          {(about) => (
            <p class="mt-2 text-sm break-words">
              <RichText
                text={about()}
                bare
                emojis={profile()?.emojis}
              />
            </p>
          )}
        </Show>
        <p class="mt-2 flex flex-wrap gap-x-4 text-xs text-(--ink-quiet)">
          <Show when={follows() !== null}>
            <span>フォロー {follows()}</span>
          </Show>
          <Show when={joined()}>
            <span>登録 {joined()}</span>
          </Show>
        </p>
      </div>
    </header>
  );
}



/**
 * A profile page: the header, the Notes / Replies and notes tabs, and the
 * posts themselves. The feed is loaded once per subject and kept, so
 * coming back to a profile is instant.
 */
export function ProfilePage(props: {
  pubkey: string | null;
  /** The link carried no usable pubkey. */
  invalid?: boolean;
  /** True while the URL asks for the Replies and notes tab. */
  replies?: boolean;
  onSelect: (event: NostrEvent) => void;
}) {
  const { pubkey: self } = useAuth();
  const feed = useProfileFeed();
  const { buffered, subject } = useProfileLive();
  const subject0 = (): string | null =>
    props.invalid === true ? null : (props.pubkey ?? self() ?? null);

  onMount(() => {
    openProfile(subject0());
  });
  createEffect(() => {
    openProfile(subject0());
  });

  // The URL names the tab, so a shared profile link opens the tab it
  // asks for and the back button walks the tab history.
  createEffect(() => {
    const next: FeedTab = props.replies === true ? "replies" : "notes";
    untrack(() => {
      if (feed.tab() !== next) selectProfileTab(next);
    });
  });

  const onTab = (tab: FeedTab): void => {
    const base =
      props.invalid === true || props.pubkey === null
        ? "#/profile"
        : profileHash(props.pubkey);
    navigate(feedHash(base, tab === "replies"));
  };

  // A profile that could not be loaded has to be asked for again. Only the home
  // timeline retried, so this one sat on "this person has not posted" with no
  // second attempt — the reader's only way back was to leave and return.
  retryWhilePending(feed, loadMoreProfile);

  // The arrivals row and the load-more control both move the list when they come
  // or go. The signals are read *outside* `untrack`, or the effect tracks
  // nothing and runs once for the life of the page — which is what left every new
  // post from this person pushing the reader's post off the screen.
  createEffect(() => {
    // The row is only ever shown for the profile on screen, so the two have to
    // agree: a buffered post from somebody else must not make this profile's list
    // jump.
    const arriving = subject() === feed.subject() && buffered().length > 0;
    untrack(() => noteBarVisibility(arriving));
  });

  return (
    <Show
      when={props.invalid === true ? "" : subject0()}
      fallback={
        <p class="px-4 py-6 text-(--ink-muted)">
          {props.invalid === true
            ? "プロフィールのリンクが壊れています (pubkey がありません)。"
            : "プロフィールを見るにはログインしてください (Settings)。"}
        </p>
      }
    >
      {(author) => (
        <div>
          {/* The bar and the profile header share a region, which is what
              bounds where the pinned bar goes: it hovers over the banner and
              is pushed up and out as the region ends, exactly where the tab
              row below takes the top. Bounding it any later would have the
              tabs cover it instead. */}
          <div>
            <PageBar id={author()} />
            <ProfileHeader pubkey={author()} />
          </div>
          <div ref={feed.setHeaderRef} class="sticky top-0 z-30 bg-(--surface)">
            <FeedTabs tab={feed.tab()} onSelect={onTab} />
            <Show when={subject() === author() && buffered().length > 0}>
              <button
                ref={feed.setBarRef}
                class="block w-full border-b border-(--line) px-4 py-3 text-left hover:bg-(--accent-soft)"
                onClick={flushProfileArrivals}
              >
                新着 {buffered().length} 件
              </button>
            </Show>
          </div>
          <Show when={feed.authRelays().length > 0}>
            <p class="border-b border-(--warn) bg-(--warn-soft) px-4 py-2 text-sm text-(--warn-ink)">
              認証が必要なリレー: {feed.authRelays().join(", ")}
            </p>
          </Show>

          <div ref={feed.setListRef}>
            <Show when={feed.loading() && feed.events().length === 0}>
              <p class="px-4 py-6 text-(--ink-muted)">読み込み中…</p>
            </Show>
            <Show when={!feed.loading() && feed.events().length === 0}>
              {/* Two different things, and the difference is about someone
                  else: "this person has never posted" is a claim about a third
                  party, and it is false every time the reason is that no relay
                  answered. */}
              <p class="px-4 py-6 text-(--ink-muted)">
                {feed.failed()
                  ? "投稿を取得できませんでした。リレーの接続を確認してください。"
                  : feed.tab() === "notes"
                    ? "这只の投稿はまだありません。"
                    : "投稿はまだありません。"}
              </p>
            </Show>
            <For each={feed.events()}>
              {(event) => <EventCard event={event} onSelect={props.onSelect} />}
            </For>
            <Show when={feed.hasMore() && !feed.loading()}>
              <button
                class="block w-full border-b border-(--line) px-4 py-3 text-left hover:bg-(--accent-soft) disabled:opacity-50"
                disabled={feed.loadingMore()}
                onClick={() => void loadMoreProfile()}
              >
                {feed.loadingMore() ? "読み込み中…" : "さらに読み込む"}
              </button>
            </Show>
          </div>
          <Show when={!feed.hasMore() && feed.events().length > 0}>
            <p class="px-4 py-4 text-sm text-(--ink-muted)">
              {feed.coverage() === "complete"
                ? "すべての投稿を読み込みました"
                : "取得可能な投稿を読み込みました (一部未確認)"}
            </p>
          </Show>
        </div>
      )}
    </Show>
  );
}
