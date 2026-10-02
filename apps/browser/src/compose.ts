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
import { isOwn, markDeleted } from "./deleted.js";
import { lookupEvent, rememberEvents } from "./event-cache.js";
import { showNotice } from "./notice.js";
import { getConnection } from "./nostr.js";
import {
  noteWriteResult,
  type RelayInfo,
} from "./relays.js";
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

/** Why a publish did not go out, so the caller can say which it was. */
export type PublishFailure =
  | "no-signer"
  | "no-relay"
  | "rejected"
  /** The reader dismissed the signature prompt, so nothing was signed. */
  | "cancelled"
  | "empty";

/** Signs and broadcasts to every relay, then caches for deep links. */
export async function publishEvent(
  template: {
    pubkey: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
  },
  /** Set by the dialog only; a form or a store reports the reason itself. */
  reportError: (reason: PublishFailure) => void = (reason) =>
    setError(FAILURE_TEXT[reason]),
): Promise<NostrEvent | null> {
  const signer = getSigner();
  if (signer === null) {
    reportError("no-signer");
    return null;
  }
  // Signing can refuse, and refusing is ordinary: a NIP-07 extension asks the
  // reader to confirm and throws when the dialog is dismissed. That has to come
  // back as a reason like any other, or the caller is left with a rejected
  // promise, a button that stops working and nothing said about why.
  let event: NostrEvent;
  try {
    event = await signer.signEvent(template);
  } catch {
    reportError("cancelled");
    return null;
  }
  rememberEvents([event]);
  const accepted = await sendToWriteRelays(event);
  if (accepted === 0) {
    reportError("rejected");
    return null;
  }
  return event;
}

/**
 * Sends an already-signed event to every relay the reader writes to, and says
 * how many took it.
 *
 * The event is sent as it is: an id and a signature are the author's, and
 * re-signing would produce a different event that no longer says what they
 * wrote. That is what lets someone put another person's post onto their own
 * relays without claiming to have written it.
 */
async function sendToWriteRelays(event: NostrEvent): Promise<number> {
  // Only relays marked for writing receive what the reader publishes.
  const urls = useRelays().writeRelays();
  if (urls.length === 0) return 0;
  const settled = await Promise.allSettled(
    urls.map(async (url) => {
      // A relay that accepts the socket and never answers (relay.damus.io
      // does) must not hold the button hostage, so every publish is raced.
      return Promise.race([
        getConnection(url).publish(event),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), PUBLISH_TIMEOUT_MS),
        ),
      ]);
    }),
  );
  let accepted = 0;
  settled.forEach((result, index) => {
    const url = urls[index];
    const ok = result.status === "fulfilled" && result.value?.accepted === true;
    if (ok) accepted += 1;
    // Report the outcome per relay, so write-only relays show a real state.
    noteWriteResult(url, ok);
  });
  return accepted;
}

const FAILURE_TEXT: Record<PublishFailure, string> = {
  "no-signer": "ログインが必要です (Settings)",
  "no-relay": "書き込むリレーがありません (Network)",
  rejected: "リレーに拒否されました",
  cancelled: "署名をキャンセルしました",
  empty: "本文を入力してください",
};

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** The thread root of a post, for a reply sent from a form. */
function rootForReply(target: NostrEvent): NostrEvent | null {
  const marker = target.tags.find(
    (tag) => tag[0] === "e" && tag[3] === "root" && isHex64(tag[1]),
  );
  if (marker === undefined || marker[1] === target.id) return null;
  return lookupEvent(marker[1]);
}

/**
 * Publishes a NIP-10 reply to one post, from the reply form on a detail
 * page. The dialog does the same work, but it owns modal state, so a form
 * cannot go through it. The reason is returned instead of being written to
 * the dialog's error line, which the form renders itself.
 */
export async function publishReply(
  target: NostrEvent,
  text: string,
): Promise<{ sent: NostrEvent } | { failure: PublishFailure }> {
  const pubkey = useAuth().pubkey();
  const body = text.trim();
  if (pubkey === null) return { failure: "no-signer" };
  if (body === "") return { failure: "empty" };
  const sent = await publishEvent(
    buildReply({
      pubkey,
      target,
      root: rootForReply(target),
      text: body,
      createdAt: now(),
    }),
    () => undefined,
  );
  if (sent === null) return { failure: "rejected" };
  // Remember the action, so the post's row shows it was answered.
  markReplied(target.id);
  showNotice("リプライしました");
  return { sent };
}

/** Message for a failure the reply form has to show. */
export function replyFailureText(reason: PublishFailure): string {
  return FAILURE_TEXT[reason];
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
        ? await publishEvent({ pubkey, created_at, kind: 1, tags: [], content: body })
        : mode() === "quote"
          ? await publishEvent(
              buildQuoteRepost({
                pubkey,
                target: current,
                text: body,
                createdAt: created_at,
              }),
            )
          : await publishEvent(
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
        ? await publishEvent(buildRepost({ pubkey, target: event, createdAt: now() }))
        : await publishEvent(
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

/**
 * Puts a post onto the reader's own relays, whoever wrote it.
 *
 * The event is sent exactly as its author signed it. A relay stores what it
 * is given, so this is how a post that only lives on relays the reader does not
 * use ends up on their own set, and how their own post reaches a relay that
 * missed it. It is not a repost: nothing refers to the post and no new event is
 * created, so the copy on the new relay is the same event with the same id.
 *
 * What it cannot do is make the post appear for people who are not connected to
 * these relays, which is why the notice names how many relays took it.
 */
export async function broadcastEvent(event: NostrEvent): Promise<boolean> {
  if (useRelays().writeRelays().length === 0) {
    showNotice("書き込むリレーがありません (Network)");
    return false;
  }
  const accepted = await sendToWriteRelays(event);
  if (accepted === 0) {
    showNotice("再配信できませんでした");
    return false;
  }
  showNotice(`${accepted} つのリレーに再配信しました`);
  return true;
}

/**
 * NIP-09 deletion of the reader's own post.
 *
 * A deletion request is a request, not a removal: the event stays in the
 * relays that do not honour NIP-09, and every client has to apply it. So the
 * post is taken off this screen the moment the request is out, and the request
 * itself is remembered as one of the reader's own events, which is what a
 * reload rebuilds from.
 */
export async function deleteEvent(event: NostrEvent): Promise<boolean> {
  const pubkey = useAuth().pubkey();
  if (pubkey === null) {
    showNotice("削除するにはログインしてください");
    return false;
  }
  if (!isOwn(event, pubkey)) {
    // A deletion request for someone else's post is not a deletion, it is a
    // claim, and no relay will act on it.
    showNotice("自分の投稿だけを削除できます");
    return false;
  }
  setBusy(true);
  try {
    const sent = await publishEvent(
      buildDeletion({
        pubkey,
        eventIds: [event.id],
        // NIP-09 lets `k` name the kinds the request covers, which is what a
        // relay uses to decide whether it may drop the event.
        kinds: [event.kind],
        createdAt: now(),
      }),
    );
    if (sent === null) {
      showNotice("削除に失敗しました");
      return false;
    }
    // The post is gone from every list the app shows before any of them has
    // been refetched, so the reader sees the result of what they just did.
    markDeleted([event.id]);
    // The request is the reader's own event, so a reload finds it again and
    // keeps the post out of sight without the reader doing anything.
    showNotice("削除しました");
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
        ? await publishEvent(
            buildReaction({ pubkey, target: event, createdAt: now() }),
          )
        : await publishEvent(
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
