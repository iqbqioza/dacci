import type { NostrEvent } from "dacci-nostr-nips";
import {
  buildDeletion,
  buildQuoteRepost,
  buildReaction,
  buildReply,
  buildRepost,
  REACTION_KIND,
  REPOST_KIND,
} from "dacci-nostr-nips";
import { createSignal } from "solid-js";
import { getSigner, useAuth } from "./auth.jsx";
import { lookupEvent, rememberEvents } from "./event-cache.js";
import { showNotice } from "./notice.js";
import { getConnection } from "./nostr.js";
import {
  activityFor,
  clearReacted,
  clearReposted,
  markQuoted,
  markReacted,
  markReposted,
  markReplied,
} from "./my-actions.js";
import { useRelays } from "./relays.js";

/**
 * Compose state lives at module level so an action on any card can open the
 * same dialog, and the published event is signed and broadcast in one place.
 */
export type ComposeMode = "new" | "reply" | "quote";

const [open, setOpen] = createSignal(false);
const [mode, setMode] = createSignal<ComposeMode>("new");
const [target, setTarget] = createSignal<NostrEvent | null>(null);
const [busy, setBusy] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);

export const composeOpen = open;
export const composeMode = mode;
export const composeTarget = target;
export const composeBusy = busy;
export const composeError = error;

function openWith(nextMode: ComposeMode, event: NostrEvent | null): void {
  setMode(nextMode);
  setTarget(event);
  setError(null);
  setOpen(true);
}

export function openNewPost(): void {
  openWith("new", null);
}

export function openReply(event: NostrEvent): void {
  openWith("reply", event);
}

export function openQuote(event: NostrEvent): void {
  openWith("quote", event);
}

export function closeCompose(): void {
  setOpen(false);
  setError(null);
}

/**
 * The thread root of a post, when the relay told us (NIP-10 marker) and the
 * event is cached. Replies need it to keep the thread intact for others.
 */
function rootOf(event: NostrEvent): NostrEvent | null {
  const marker = event.tags.find(
    (tag) => tag[0] === "e" && tag[3] === "root" && isHex64(tag[1]),
  );
  if (marker === undefined || marker[1] === event.id) return null;
  return lookupEvent(marker[1]);
}

function isHex64(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{64}$/.test(value);
}

/** How long one relay may take before the publish moves on without it. */
const PUBLISH_TIMEOUT_MS = 5000;

/** Signs and broadcasts to every relay, then caches for deep links. */
async function publish(template: {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}): Promise<NostrEvent | null> {
  const signer = getSigner();
  if (signer === null) {
    setError("ログインが必要です (Settings)");
    return null;
  }
  const event = await signer.signEvent(template);
  const urls = useRelays().relayUrls();
  const settled = await Promise.allSettled(
    urls.map(async (url) => {
      // A relay that accepts the socket and never answers (relay.damus.io
      // does) must not hold the button hostage, so every publish is raced.
      const result = await Promise.race([
        getConnection(url).publish(event),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), PUBLISH_TIMEOUT_MS),
        ),
      ]);
      return result;
    }),
  );
  const accepted = settled.filter(
    (result) =>
      result.status === "fulfilled" && result.value?.accepted === true,
  ).length;
  rememberEvents([event]);
  if (accepted === 0) {
    setError("リレーに拒否されました");
    return null;
  }
  return event;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** Publishes the dialog's text as a note, a reply or a quote repost. */
export async function submitCompose(text: string): Promise<boolean> {
  const pubkey = useAuth().pubkey();
  const body = text.trim();
  if (pubkey === null || body === "") return false;
  const current = target();
  setBusy(true);
  setError(null);
  try {
    const created_at = now();
    const sent =
      current === null
        ? await publish({ pubkey, created_at, kind: 1, tags: [], content: body })
        : mode() === "quote"
          ? await publish(
              buildQuoteRepost({
                pubkey,
                target: current,
                text: body,
                createdAt: created_at,
              }),
            )
          : await publish(
              buildReply({
                pubkey,
                target: current,
                root: rootOf(current),
                text: body,
                createdAt: created_at,
              }),
            );
    if (sent !== null) {
      // Remember the action on the post, so its row shows it was taken and
      // can be undone from another tab or after a reload.
      if (current !== null) {
        if (mode() === "quote") markQuoted(current.id, sent.id);
        else markReplied(current.id);
      }
      showNotice(
        current === null
          ? "投稿しました"
          : mode() === "quote"
            ? "引用投稿しました"
            : "リプライしました",
      );
      closeCompose();
    }
    return sent !== null;
  } catch (caught) {
    setError(caught instanceof Error ? caught.message : "投稿に失敗しました");
    return false;
  } finally {
    setBusy(false);
  }
}

/**
 * NIP-18 repost, as a toggle: a second press publishes a NIP-09 deletion for
 * the repost, so the row and every other client agree it is gone.
 */
export async function toggleRepost(event: NostrEvent): Promise<boolean> {
  const pubkey = useAuth().pubkey();
  if (pubkey === null) {
    showNotice("リポストするにはログインしてください");
    return false;
  }
  if (event.pubkey === pubkey) {
    showNotice("自分の投稿はリポストできません");
    return false;
  }
  const existing = activityFor(event.id).repost;
  setBusy(true);
  try {
    const sent =
      existing === undefined
        ? await publish(buildRepost({ pubkey, target: event, createdAt: now() }))
        : await publish(
            buildDeletion({
              pubkey,
              eventIds: [existing],
              kinds: [REPOST_KIND],
              createdAt: now(),
            }),
          );
    if (sent === null) {
      showNotice(
        existing === undefined ? "リポストに失敗しました" : "リポストを取り消せませんでした",
      );
      return false;
    }
    if (existing === undefined) markReposted(event.id, sent.id);
    else clearReposted(event.id);
    showNotice(existing === undefined ? "リポストしました" : "リポストを取り消しました");
    return true;
  } finally {
    setBusy(false);
  }
}

/** NIP-25 like, as a toggle: undoing it is a NIP-09 deletion. */
export async function toggleReaction(event: NostrEvent): Promise<boolean> {
  const pubkey = useAuth().pubkey();
  if (pubkey === null) {
    showNotice("リアクションするにはログインしてください");
    return false;
  }
  const existing = activityFor(event.id).react;
  setBusy(true);
  try {
    const sent =
      existing === undefined
        ? await publish(
            buildReaction({ pubkey, target: event, createdAt: now() }),
          )
        : await publish(
            buildDeletion({
              pubkey,
              eventIds: [existing],
              kinds: [REACTION_KIND],
              createdAt: now(),
            }),
          );
    if (sent === null) {
      showNotice(
        existing === undefined
          ? "リアクションに失敗しました"
          : "リアクションを取り消せませんでした",
      );
      return false;
    }
    if (existing === undefined) markReacted(event.id, sent.id);
    else clearReacted(event.id);
    showNotice(
      existing === undefined ? "リアクションしました" : "リアクションを取り消しました",
    );
    return true;
  } finally {
    setBusy(false);
  }
}
