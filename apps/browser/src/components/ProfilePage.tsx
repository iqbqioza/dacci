import type { NostrEvent } from "dacci-nostr-nips";
import { CONTACTS_KIND, encodeNpub, parseContacts } from "dacci-nostr-nips";
import { createEffect, For, onMount, Show, untrack } from "solid-js";
import { useAuth } from "../auth.jsx";
import { EventCard } from "./EventCard.jsx";
import { ProfileAvatar, ProfileName } from "./ProfileAvatar.jsx";
import { FeedTabs, type FeedTab } from "../feed-tabs.jsx";
import {
  flushProfileArrivals,
  loadMoreProfile,
  openProfile,
  selectProfileTab,
  useProfileFeed,
} from "../profile-feed.js";
import { feedHash, navigate, profileHash } from "../router.js";
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
export function ProfileHeader(props: { pubkey: string; compact?: boolean }) {
  const profile = () => useProfile(props.pubkey).profile;
  const follows = useFollowCount(props.pubkey);
  const banner = () => profile()?.banner ?? null;
  const joined = (): string | null => {
    const at = profile()?.createdAt;
    return at === undefined ? null : formatDate(at);
  };

  return (
    <header class="border-b border-(--dads-solid-gray-200)">
      <div class={`relative w-full overflow-hidden bg-(--dads-solid-gray-200) ${BANNER_RATIO}`}>
        <Show when={banner()}>
          {(url) => (
            <img
              src={url()}
              alt=""
              class="h-full w-full object-cover"
              loading="lazy"
              decoding="async"
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
            class="rounded-full ring-4 ring-white"
          />
        </div>
        <div class="flex flex-wrap items-center gap-x-2">
          <span class="text-lg font-bold">
            <ProfileName pubkey={props.pubkey} />
          </span>
          <Show when={profile()?.nip05}>
            {(identifier) => (
              <span class="text-xs text-(--dads-solid-gray-600)">
                {identifier()}
              </span>
            )}
          </Show>
        </div>
        <p class="font-mono text-xs break-all text-(--dads-solid-gray-600)">
          {encodeNpub(props.pubkey) ?? props.pubkey}
        </p>
        <Show when={profile()?.about}>
          {(about) => (
            <p class="mt-2 text-sm break-words whitespace-pre-wrap">
              {about()}
            </p>
          )}
        </Show>
        <p class="mt-2 flex flex-wrap gap-x-4 text-xs text-(--dads-solid-gray-600)">
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

function formatDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString("ja-JP");
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

  return (
    <Show
      when={props.invalid === true ? "" : subject0()}
      fallback={
        <p class="px-4 py-6 text-(--dads-solid-gray-500)">
          {props.invalid === true
            ? "プロフィールのリンクが壊れています (pubkey がありません)。"
            : "プロフィールを見るにはログインしてください (Settings)。"}
        </p>
      }
    >
      {(author) => (
        <div>
          <ProfileHeader pubkey={author()} />
          <div ref={feed.setHeaderRef} class="sticky top-0 z-20 bg-white">
            <FeedTabs tab={feed.tab()} onSelect={onTab} />
            <Show when={subject() === author() && buffered().length > 0}>
              <button
                class="block w-full border-b border-(--dads-solid-gray-200) px-4 py-3 text-left hover:bg-(--dads-blue-50)"
                onClick={flushProfileArrivals}
              >
                新着 {buffered().length} 件
              </button>
            </Show>
          </div>
          <Show when={feed.authRelays().length > 0}>
            <p class="border-b border-(--dads-yellow-600) bg-(--dads-yellow-50) px-4 py-2 text-sm text-(--dads-solid-gray-800)">
              認証が必要なリレー: {feed.authRelays().join(", ")}
            </p>
          </Show>

          <div ref={feed.setListRef}>
            <Show when={feed.loading() && feed.events().length === 0}>
              <p class="px-4 py-6 text-(--dads-solid-gray-500)">読み込み中…</p>
            </Show>
            <Show when={!feed.loading() && feed.events().length === 0}>
              <p class="px-4 py-6 text-(--dads-solid-gray-500)">
                {feed.tab() === "notes"
                  ? "这只の投稿はまだありません。"
                  : "投稿はまだありません。"}
              </p>
            </Show>
            <For each={feed.events()}>
              {(event) => <EventCard event={event} onSelect={props.onSelect} />}
            </For>
            <Show when={feed.hasMore() && !feed.loading()}>
              <button
                class="block w-full border-b border-(--dads-solid-gray-200) px-4 py-3 text-left hover:bg-(--dads-blue-50) disabled:opacity-50"
                disabled={feed.loadingMore()}
                onClick={() => void loadMoreProfile()}
              >
                {feed.loadingMore() ? "読み込み中…" : "さらに読み込む"}
              </button>
            </Show>
          </div>
          <Show when={!feed.hasMore() && feed.events().length > 0}>
            <p class="px-4 py-4 text-sm text-(--dads-solid-gray-500)">
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
