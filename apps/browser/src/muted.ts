import { authenticatedAnswer } from "./authored.js";
import type { Filter, NostrEvent } from "dacci-nostr-nips";
import {
  buildMuteList,
  MUTE_LIST_KIND,
  muteTags,
  mutedIn,
  withMuted,
} from "dacci-nostr-nips";
import { createSignal } from "solid-js";
import { useAuth } from "./auth.jsx";
import { publishEvent, publishFailureText } from "./compose.js";
import { showNotice } from "./notice.js";
import { getConnection } from "./nostr.js";
import { useRelays } from "./relays.js";

/**
 * The reader's own NIP-51 mute list.
 *
 * A mute hides a person's posts on this device, and that is the whole of what
 * it can do: the events stay on the relays and every other client is free to
 * show them. The list is published anyway, because NIP-51 defines it as a
 * replaceable list and other clients do read it — it is a record of what this
 * reader does not want to see, not a way to remove anything.
 *
 * Publishing means republishing the whole list, so a list that was never read
 * must never be published: an empty list looks like a reader who mutes nobody,
 * and writing that would silently unblock everyone they had muted.
 */
const [tags, setTags] = createSignal<string[][]>([]);
/** Whether the list has been read, so a button is never a guess. */
const [loaded, setLoaded] = createSignal(false);
const [pending, setPending] = createSignal(false);
const [owner, setOwner] = createSignal<string | null>(null);
/** Incremented for every read, so a stale answer can be recognised as stale. */
let readGeneration = 0;

const SYNC_TIMEOUT_MS = 5000;

export interface MuteState {
  /** null while the list is unknown, so a button is never a guess. */
  muted: () => boolean | null;
  /** True while the list is being read, or a change is being published. */
  busy: () => boolean;
  toggle: () => Promise<void>;
}

/**
 * Whether the reader has muted someone, and the toggle that changes it.
 *
 * A signed-out reader has muted nobody, which is known rather than unknown, so
 * the row is offered rather than stuck on a loading label.
 */
export function useMuteState(pubkey: string): MuteState {
  requestMyMutes();
  return {
    muted: (): boolean | null =>
      useAuth().pubkey() === null ? false : loaded() ? mutedIn(tags(), pubkey) : null,
    busy: () => useAuth().pubkey() !== null && pending(),
    toggle: async () => {
      await toggleMute(pubkey);
    },
  };
}

/** Queues the list once per session and per reader. */
export function requestMyMutes(): void {
  const key = useAuth().pubkey();
  if (key === null) return;
  // A different reader has a different list, and a read still running belongs
  // to the reader who started it: its answer must not be taken as this one's.
  if (owner() !== key) {
    setOwner(key);
    setLoaded(false);
    setTags([]);
    setPending(false);
  }
  if (loaded() || pending()) return;
  setPending(true);
  void loadMyMutes(key);
}

async function loadMyMutes(key: string): Promise<void> {
  // Bumped for every read, so a reply that arrives after a reader change, or
  // after a reset, is dropped instead of being written as the current answer.
  const generation = ++readGeneration;
  const filter: Filter = { kinds: [MUTE_LIST_KIND], authors: [key], limit: 5 };
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
        if (result?.failed === true || result === null) return null;
        return authenticatedAnswer(result.events, key);
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
  // A reader change or a reset happened while this was in flight, so the answer
  // belongs to a list nobody is looking at any more. Writing it would put one
  // reader's mutes under another's key.
  if (generation !== readGeneration) return;
  setPending(false);
  // No relay answered, so the list is still unknown. Leaving it unknown keeps
  // the row from claiming the reader has muted nobody when they have not said.
  if (answered === 0) return;
  // Kind 10000 is replaceable, so the newest list is the current one. A reader
  // who has never muted anyone has no kind 10000 at all, and that is an empty
  // list rather than an unknown one.
  events.sort((a, b) => b.created_at - a.created_at);
  const newest = events[0];
  setTags(newest === undefined ? [] : muteTags(newest));
  setLoaded(true);
}

/** Mutes or unmutes someone by republishing the whole list. */
export async function toggleMute(pubkey: string): Promise<void> {
  const key = useAuth().pubkey();
  if (key === null) {
    showNotice("ミュートするにはログインしてください");
    return;
  }
  if (key === pubkey) {
    showNotice("自分自身はミュートできません");
    return;
  }
  if (pending()) return;
  // A list that was never read is not an empty list. Publishing one built from
  // it would un-mute everyone the reader muted in every other client.
  if (!loaded()) {
    showNotice("ミュート一覧を読み込んでいます");
    return;
  }
  const was = mutedIn(tags(), pubkey);
  // The publish is a signing prompt plus up to five seconds of relay time, so
  // the reader can change accounts while it is out. The list being written was
  // the previous reader's, and `setLoaded(true)` would claim it is resolved for
  // whoever is on screen — whose next mute would publish this list under their
  // own key and un-mute everyone they muted elsewhere.
  const generation = readGeneration;
  setPending(true);
  try {
    const next = withMuted(tags(), pubkey, !was);
    const sent = await publishEvent(
      buildMuteList({
        pubkey: key,
        tags: next,
        createdAt: Math.floor(Date.now() / 1000),
      }),
      // The reason is reported here rather than in the compose dialog's error
      // line, which a mute never opens.
      (reason) => showNotice(publishFailureText(reason, was ? "ミュート解除" : "ミュート")),
    );
    if (sent === null) return;
    if (generation !== readGeneration || useAuth().pubkey() !== key) return;
    setTags(next);
    setLoaded(true);
    showNotice(was ? "ミュートを解除しました" : "ミュートしました");
  } finally {
    // Only the call that queued the round clears the flag; a newer read has
    // taken it over by now and is the one that should release it.
    if (generation === readGeneration) setPending(false);
  }
}

/**
 * Whether a post's author is muted, for the lists a mute covers.
 *
 * NIP-51 scopes a mute to feeds, so this is asked by the home feed and by
 * nothing else: the person's own profile page, a direct link to one of their
 * posts and a conversation are all places a reader went on purpose.
 */
export function isMutedAuthor(pubkey: string): boolean {
  if (!loaded()) return false;
  return mutedIn(tags(), pubkey);
}

/** Dropped on a login change and a relay change, so the list is read again. */
export function resetMyMutes(): void {
  // A read in flight belongs to the list that was just dropped.
  readGeneration += 1;
  setOwner(null);
  setTags([]);
  setLoaded(false);
  setPending(false);
}