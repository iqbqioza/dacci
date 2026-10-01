import type { Filter, NostrEvent } from "dacci-nostr-nips";
import {
  buildFollowList,
  CONTACTS_KIND,
  contactTags,
  followsIn,
  withFollowed,
} from "dacci-nostr-nips";
import { createSignal } from "solid-js";
import { useAuth } from "./auth.jsx";
import { publishEvent } from "./compose.js";
import { showNotice } from "./notice.js";
import { getConnection } from "./nostr.js";
import { useRelays } from "./relays.js";

/**
 * The reader's own NIP-02 follow list.
 *
 * NIP-02 has no event for a single follow: the list is one replaceable kind 3,
 * so following someone means reading the list, adding a `p` tag and
 * publishing the whole thing again. That makes this store different from the
 * action rows on a post, which are one event each: the state lives in the
 * event the reader published, and the local copy only paints it immediately.
 *
 * A following is not a private fact, so nothing is written to localStorage
 * here: the relays already hold the list, and a copy that drifted from them
 * would show the reader following someone they had unfollowed elsewhere.
 */
const [tags, setTags] = createSignal<string[][]>([]);
/** Whether the list has been read yet, so a button is never a guess. */
const [loaded, setLoaded] = createSignal(false);
const [pending, setPending] = createSignal(false);
const [owner, setOwner] = createSignal<string | null>(null);

const SYNC_TIMEOUT_MS = 5000;

export interface FollowState {
  /** null while the list is unknown, so a button is never a guess. */
  following: () => boolean | null;
  /** True while the list is being read, or a change is being published. */
  loading: () => boolean;
  toggle: () => Promise<void>;
}

/**
 * Whether the reader follows someone, and the toggle that changes it. Reading
 * this asks for the list once; a list already read is never re-asked.
 *
 * A signed-out reader follows nobody, which is known rather than unknown, so
 * the button reads "フォロー" and pressing it says what is missing instead of
 * waiting for a list that will never arrive.
 */
export function useFollowState(pubkey: string): FollowState {
  requestMyFollows();
  const following = (): boolean | null =>
    useAuth().pubkey() === null ? false : loaded() ? followsIn(tags(), pubkey) : null;
  return {
    following,
    // Only a read in flight is a wait; a list that is simply not there yet is
    // the unknown state the label already says.
    loading: () => useAuth().pubkey() !== null && pending(),
    toggle: async () => {
      await toggleFollow(pubkey);
    },
  };
}

/** Queues the list once per session and per reader. */
export function requestMyFollows(): void {
  const key = useAuth().pubkey();
  if (key === null) return;
  // A different reader has a different list.
  if (owner() !== key) {
    setOwner(key);
    setLoaded(false);
    setTags([]);
  }
  if (loaded() || pending()) return;
  setPending(true);
  void loadMyFollows(key);
}

async function loadMyFollows(key: string): Promise<void> {
  const filter: Filter = { kinds: [CONTACTS_KIND], authors: [key], limit: 5 };
  const settled = await Promise.allSettled(
    useRelays()
      .readRelays()
      .map(async (url) => {
        const result = await Promise.race([
          getConnection(url).query(filter, SYNC_TIMEOUT_MS),
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), SYNC_TIMEOUT_MS),
          ),
        ]);
        // A relay that refused is not an answer, so it is kept apart from one
        // that replied with nothing.
        return result?.failed === true || result === null ? null : result.events;
      }),
  );
  const events: NostrEvent[] = [];
  let answered = 0;
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value !== null) {
      answered += 1;
      events.push(...result.value);
    }
  }
  setPending(false);
  // No relay answered, so the list is still unknown. Leaving it unknown keeps
  // the button from claiming the reader does not follow someone they do.
  if (answered === 0) return;
  // Kind 3 is replaceable, so the newest list is the current one. A reader who
  // has never followed anyone has no kind 3 at all, and that is an empty list
  // rather than an unknown one.
  events.sort((a, b) => b.created_at - a.created_at);
  const newest = events[0];
  setTags(newest === undefined ? [] : contactTags(newest));
  setLoaded(true);
}

/**
 * Follows or unfollows someone by publishing the whole list again, then
 * adopting what was published. The relays may answer a later kind 3 before
 * this one reaches them, so the local copy is a first paint and the next read
 * is the truth.
 */
export async function toggleFollow(pubkey: string): Promise<void> {
  const key = useAuth().pubkey();
  if (key === null) {
    showNotice("フォローするにはログインしてください");
    return;
  }
  if (key === pubkey) {
    showNotice("自分自身はフォローできません");
    return;
  }
  if (pending()) return;
  // A list that was never read is not an empty list. Publishing one built
  // from it would drop every other follow the reader has, on every client.
  if (!loaded()) {
    showNotice("フォロー一覧を読み込んでいます");
    return;
  }
  const was = followsIn(tags(), pubkey);
  setPending(true);
  try {
    const next = withFollowed(tags(), pubkey, !was);
    const sent = await publishEvent(
      buildFollowList({
        pubkey: key,
        tags: next,
        createdAt: Math.floor(Date.now() / 1000),
      }),
      // The reason is reported here rather than in the compose dialog's error
      // line, which a follow never opens.
      () => undefined,
    );
    if (sent === null) {
      showNotice(was ? "フォロー解除に失敗しました" : "フォローに失敗しました");
      return;
    }
    setTags(next);
    setLoaded(true);
    showNotice(was ? "フォロー解除しました" : "フォローしました");
  } finally {
    setPending(false);
  }
}

/** Dropped on a login change and a relay change, so the list is read again. */
export function resetMyFollows(): void {
  setOwner(null);
  setTags([]);
  setLoaded(false);
  setPending(false);
}