import type { NostrEvent } from "dacci-nostr-nips";
import { authenticatedAnswer } from "./authored.js";
import {
  deletedEventIds,
  summarizeMyActivity,
  type MyActivity,
  type MyActivityMap,
} from "dacci-nostr-nips";
import { createSignal } from "solid-js";
import { getConnection } from "./nostr.js";
import { useRelays } from "./relays.js";
import { safeStorage } from "./storage.js";

/**
 * What the signed-in reader has already done to each post.
 *
 * The state is kept twice: in localStorage, so a reload paints the correct
 * action row immediately, and reconciled from the reader's own events on the
 * relays, which is what makes it survive a reload on another tab and picks
 * up actions taken elsewhere. Only the ids of the reader's own events are
 * stored, so an action can be undone with a NIP-09 deletion.
 */
const STORAGE_PREFIX = "dacci.my-activity:";

/** Kinds of our own events that describe what we did: reply, delete, repost, react. */
const ACTIVITY_KINDS = [1, 5, 6, 7];
/**
 * How much of the reader's own history one round covers.
 *
 * A signed answer is the only one allowed to remove an action, so every event
 * in it is verified, and a verification costs about 370× an id check. 500 would
 * be well over a second of blocked tab; this is a few days of reactions and
 * reposts, which is the part a stale answer could plausibly contradict.
 */
const SIGNED_WINDOW = 50;
const SYNC_TIMEOUT_MS = 5000;

const [activity, setActivity] = createSignal<MyActivityMap>(new Map());
const [pubkey, setPubkey] = createSignal<string | null>(null);

/**
 * Bumped whenever the account changes, so a round that is still out belongs to
 * the account that asked for it and cannot answer for the next one.
 */
let readGeneration = 0;

export const myActivity = activity;
export const myActivityPubkey = pubkey;

/**
 * The reader's own action rows, kept per account so two accounts in one browser
 * never see each other's.
 *
 * Storage is not load-bearing here — the relays hold the reader's own events and
 * every login reconciles against them — so a browser that will not store this
 * loses a faster first paint and nothing else.
 */
const store = safeStorage("local");

function read(pubkey: string): MyActivityMap {
  const raw = store.get(`${STORAGE_PREFIX}${pubkey}`);
  if (raw === null) return new Map();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return new Map();
    return new Map(Object.entries(parsed as Record<string, MyActivity>));
  } catch {
    return new Map();
  }
}

function write(pubkey: string, map: MyActivityMap): void {
  store.set(`${STORAGE_PREFIX}${pubkey}`, JSON.stringify(Object.fromEntries(map)));
}

function update(pubkey: string, mutate: (map: MyActivityMap) => MyActivityMap): void {
  setActivity((prev) => {
    const next = mutate(new Map(prev));
    // An undone action leaves an empty record behind; drop those so the
    // stored state only lists posts that still have something on them.
    for (const [target, value] of [...next]) {
      if (Object.keys(value).length === 0) next.delete(target);
    }
    write(pubkey, next);
    return next;
  });
}

function entry(map: MyActivityMap, eventId: string): MyActivity {
  const current = map.get(eventId);
  if (current === undefined) {
    const created: MyActivity = {};
    map.set(eventId, created);
    return created;
  }
  return current;
}

/** Actions the reader has taken on one post. */
export function activityFor(eventId: string): MyActivity {
  return activity().get(eventId) ?? {};
}

export function hasDone(
  kind: keyof MyActivity,
  eventId: string,
): boolean {
  return activityFor(eventId)[kind] !== undefined;
}

/**
 * The account an action belongs to, or null when it is not that account's.
 *
 * These are recorded only once the publish has resolved, which is after a
 * signing prompt and up to five seconds of relay time. Reading the viewer at
 * that point records it against whoever signed in meanwhile: an event the
 * previous account signed would sit in this account's map, be written to this
 * account's storage for good, and its action row would then offer to undo it by
 * publishing a NIP-09 under a key that never signed it.
 *
 * `signedAs` is the account that signed. Left out, the current viewer is taken
 * as the signer, which is what every caller within one account's session wants.
 */
function ownerFor(signedAs?: string | null): string | null {
  const key = pubkey();
  if (key === null) return null;
  if (signedAs !== undefined && signedAs !== key) return null;
  return key;
}

export function markReplied(eventId: string, signedAs?: string | null): void {
  const key = ownerFor(signedAs);
  if (key === null) return;
  update(key, (map) => {
    entry(map, eventId).replied = true;
    return map;
  });
}

export function markReposted(
  eventId: string,
  repostEventId: string,
  signedAs?: string | null,
): void {
  const key = ownerFor(signedAs);
  if (key === null) return;
  update(key, (map) => {
    entry(map, eventId).repost = repostEventId;
    return map;
  });
}

export function markQuoted(
  eventId: string,
  quoteEventId: string,
  signedAs?: string | null,
): void {
  const key = ownerFor(signedAs);
  if (key === null) return;
  update(key, (map) => {
    entry(map, eventId).quote = quoteEventId;
    return map;
  });
}

export function markReacted(
  eventId: string,
  reactionEventId: string,
  signedAs?: string | null,
): void {
  const key = ownerFor(signedAs);
  if (key === null) return;
  update(key, (map) => {
    entry(map, eventId).react = reactionEventId;
    return map;
  });
}

export function clearReposted(eventId: string, signedAs?: string | null): void {
  const key = ownerFor(signedAs);
  if (key === null) return;
  update(key, (map) => {
    const current = map.get(eventId);
    if (current === undefined) return map;
    delete current.repost;
    return map;
  });
}

export function clearReacted(eventId: string, signedAs?: string | null): void {
  const key = ownerFor(signedAs);
  if (key === null) return;
  update(key, (map) => {
    const current = map.get(eventId);
    if (current === undefined) return map;
    delete current.react;
    return map;
  });
}

/** Called on login: paint from the cache, then reconcile with the relays. */
export function adoptMyActivity(next: string | null): void {
  // A read in flight belongs to the account that asked for it, so the new
  // account makes that answer stale rather than current.
  readGeneration += 1;
  setPubkey(next);
  if (next === null) {
    setActivity(new Map());
    return;
  }
  setActivity(read(next));
}

/**
 * Asks the relays what this key has already done, so the rows are right after
 * a reload and actions taken in another client are picked up.
 *
 * The answer is applied, never used to erase. An action the reader can see is
 * one they took, and the only things that may take it away are a NIP-09 request
 * that says so or an answer that genuinely covers everything: every read relay
 * answering, and the window not full. A single relay answering "nothing" while
 * the others are still loading says nothing about the rest of the reader's
 * history, and treating it as the truth would erase every highlight they have
 * and write the loss to this browser for good.
 */
export async function syncMyActivity(): Promise<void> {
  const key = pubkey();
  if (key === null) return;
  const generation = readGeneration;
  const urls = useRelays().readRelays();
  const filter = {
    kinds: ACTIVITY_KINDS,
    authors: [key],
    // Small, and deliberately so. A signed answer is the only one that may
    // remove an action, so every event in it is verified, and verification is
    // expensive enough that a window of 500 would block the tab for over a
    // second. This is the reader's own recent history — a handful of days of
    // reactions and reposts — which is the part a stale answer could plausibly
    // contradict. What a full window would be used for is the opposite check, at
    // line below, which only needs to know that the window came back full.
    limit: SIGNED_WINDOW,
  };
  const settled = await Promise.allSettled(
    urls.map(async (url) => {
      const result = await Promise.race([
        getConnection(url).query(filter, SYNC_TIMEOUT_MS),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), SYNC_TIMEOUT_MS),
        ),
      ]);
      return result?.failed === true ? null : result;
    }),
  );
  const events: NostrEvent[] = [];
  let answered = 0;
  for (const result of settled) {
    if (result.status !== "fulfilled" || result.value === null) continue;
    // These events are the reader's own actions — reactions, reposts, replies —
    // and reconciling against them is what erases an action. A relay that forges
    // one is therefore a relay that has not answered: counted as an answer it
    // would say the reader never reacted to a post they did react to.
    const kept = authenticatedAnswer(result.value.events, key);
    if (kept === null) continue;
    answered += 1;
    events.push(...kept);
  }
  // A round that is still out when the reader changes accounts answers about
  // the account that asked for it. Applying it would put the previous reader's
  // actions on this one's posts, and the next edit would write that mixture
  // under this one's key for good — an action row offering to undo an event
  // this account never signed.
  if (generation !== readGeneration || pubkey() !== key) return;
  if (answered === 0) return;
  const fresh = summarizeMyActivity(events);
  // Every relay answered and the window was not full, so this really is the
  // whole of what the reader has done lately: deletions and all.
  if (answered === urls.length && events.length < SIGNED_WINDOW) {
    setActivity(fresh);
    write(key, fresh);
    return;
  }
  const next = applyOver(activity(), fresh, events);
  setActivity(next);
  write(key, next);
}

/** The three fields that hold an event id, so they can be undone. */
const ACTION_IDS = ["react", "repost", "quote"] as const;

/**
 * What the reader had, with what this answer proves applied on top: every
 * action it reports is added, and every action it shows a NIP-09 request for is
 * removed. Everything else is left alone, because this answer is not entitled to
 * say it never happened.
 */
function applyOver(
  current: MyActivityMap,
  fresh: MyActivityMap,
  events: NostrEvent[],
): MyActivityMap {
  const undone = deletedEventIds(events);
  const next: MyActivityMap = new Map();
  for (const [target, entry] of current) {
    const kept: MyActivity = { ...entry };
    for (const name of ACTION_IDS) {
      const id = kept[name];
      if (id !== undefined && undone.has(id)) delete kept[name];
    }
    if (ACTION_IDS.some((name) => kept[name] !== undefined) || kept.replied === true) {
      next.set(target, kept);
    }
  }
  for (const [target, entry] of fresh) {
    next.set(target, { ...(next.get(target) ?? {}), ...entry });
  }
  return next;
}
