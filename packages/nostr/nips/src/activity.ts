import type { UnsignedEvent } from "./auth.js";
import type { NostrEvent } from "./event.js";

/**
 * Builders for the four post actions. Tag layouts follow the NIPs exactly,
 * because other clients read them to rebuild threads and notifications:
 *
 * - NIP-10 positional reply markers (`root`, `reply`)
 * - NIP-18 repost (`e`, `p`, `a`) and quote repost (adds `q`)
 * - NIP-25 reaction (`e`, `p`, `k`)
 * - NIP-27 `mentions` for anything addressed in the text
 */

export const REPLY_KIND = 1;
export const REPOST_KIND = 6;
export const REACTION_KIND = 7;
export const DELETION_KIND = 5;
/** NIP-22 comment. */
export const COMMENT_KIND = 1111;
export const REACTION_PLUS = "+";

/** Long-form address from a `d` tag, as NIP-18 `a` tags want it. */
function addressTag(event: NostrEvent): string[] | null {
  if (event.kind !== 30023 && event.kind !== 30024) return null;
  const d = event.tags.find((tag) => tag[0] === "d")?.[1];
  return d === undefined ? null : [`a`, `${event.kind}:${event.pubkey}:${d}`];
}

/** Every pubkey the text addresses, for the NIP-27 mentions tag. */
export function mentionedPubkeys(text: string, candidates: string[]): string[] {
  const out = new Set<string>();
  for (const pubkey of candidates) {
    if (pubkey.length !== 64) continue;
    if (text.includes(pubkey) || text.includes(`nostr:${pubkey}`)) {
      out.add(pubkey);
    }
  }
  return [...out];
}

export interface ReplyInput {
  pubkey: string;
  text: string;
  /** The post being answered. */
  target: NostrEvent;
  /** The thread root, when the target is itself a reply. */
  root?: NostrEvent | null;
  createdAt: number;
}

/**
 * NIP-10 reply to one post. When the target is a reply, the root is marked
 * as `root` and the target as `reply`; otherwise the target carries both
 * markers, which is what a top-level thread expects.
 */
export function buildReply(input: ReplyInput): UnsignedEvent {
  const { pubkey, target, root, text, createdAt } = input;
  const tags: string[][] = [];
  if (root !== undefined && root !== null && root.id !== target.id) {
    tags.push(["e", root.id, "", root.pubkey, "root"]);
    tags.push(["e", target.id, "", target.pubkey, "reply"]);
    tags.push(["p", root.pubkey]);
    tags.push(["p", target.pubkey]);
  } else {
    tags.push(["e", target.id, "", target.pubkey, "root"]);
    tags.push(["e", target.id, "", target.pubkey, "reply"]);
    tags.push(["p", target.pubkey]);
  }
  const a = addressTag(target);
  if (a !== null) tags.push(a);
  const mentions = mentionedPubkeys(text, [target.pubkey]);
  if (mentions.length > 0) tags.push(["mentions", ...mentions]);
  return {
    pubkey,
    created_at: createdAt,
    kind: REPLY_KIND,
    tags,
    content: text,
  };
}

/** NIP-18 repost: the shared event keeps the timeline working. */
export function buildRepost(input: {
  pubkey: string;
  target: NostrEvent;
  createdAt: number;
}): UnsignedEvent {
  const { pubkey, target, createdAt } = input;
  const tags: string[][] = [
    ["e", target.id],
    ["p", target.pubkey],
  ];
  const a = addressTag(target);
  if (a !== null) tags.push(a);
  return { pubkey, created_at: createdAt, kind: REPOST_KIND, tags, content: "" };
}

/** NIP-18 quote repost: a repost that carries the quoter's own words. */
export function buildQuoteRepost(input: {
  pubkey: string;
  target: NostrEvent;
  text: string;
  createdAt: number;
}): UnsignedEvent {
  const base = buildRepost(input);
  const tags: string[][] = [
    ["q", base.tags[0][1]],
    ...base.tags,
  ];
  const mentions = mentionedPubkeys(input.text, [input.target.pubkey]);
  if (mentions.length > 0) tags.push(["mentions", ...mentions]);
  return { ...base, tags, content: input.text };
}

/** NIP-25 reaction. The symbol lives in the content and in the `k` tag. */
export function buildReaction(input: {
  pubkey: string;
  target: NostrEvent;
  createdAt: number;
  symbol?: string;
}): UnsignedEvent {
  const symbol = input.symbol ?? REACTION_PLUS;
  return {
    pubkey: input.pubkey,
    created_at: input.createdAt,
    kind: REACTION_KIND,
    tags: [
      ["e", input.target.id],
      ["p", input.target.pubkey],
      ["k", symbol],
    ],
    content: symbol,
  };
}

/**
 * A NIP-22 comment, which is either the dedicated kind or, from clients
 * that predate it, a kind 1 post carrying the uppercase `I` tag.
 */
export function isComment(event: NostrEvent): boolean {
  return (
    event.kind === COMMENT_KIND ||
    event.tags.some((tag) => tag[0] === "I" || tag[0] === "i")
  );
}

/**
 * NIP-22 parent reference of a comment: the uppercase `I` tag carrying the
 * addressable event being replied to. Clients that predate the tag used a
 * plain `e` tag, so that is still accepted.
 */
export function commentParent(event: NostrEvent): string | null {
  if (!isComment(event)) return null;
  const tagged = event.tags.find(
    (tag) => (tag[0] === "I" || tag[0] === "i") && tag.length >= 4,
  );
  if (tagged !== undefined) return tagged.slice(1, 4).join(":");
  const legacy = event.tags.find((tag) => tag[0] === "e");
  return legacy === undefined ? null : (legacy[1] ?? null);
}

/**
 * NIP-09 deletion request, used to undo a reaction or a repost. `kinds` names
 * the kinds being deleted; without it a deletion applies to every kind.
 */
export function buildDeletion(input: {
  pubkey: string;
  eventIds: string[];
  kinds?: number[];
  createdAt: number;
  reason?: string;
}): UnsignedEvent {
  const tags: string[][] = [];
  for (const kind of input.kinds ?? []) tags.push(["k", String(kind)]);
  for (const id of input.eventIds) tags.push(["e", id]);
  return {
    pubkey: input.pubkey,
    created_at: input.createdAt,
    kind: DELETION_KIND,
    tags,
    content: input.reason ?? "",
  };
}

/** One post, and what the reader has done to it, keyed by post id. */
export interface MyActivity {
  /** Event id of the reader's kind 7, so the reaction can be undone. */
  react?: string;
  /** Event id of the reader's kind 6 repost. */
  repost?: string;
  /** Event id of the reader's kind 6 quote repost. */
  quote?: string;
  replied?: true;
}

export type MyActivityMap = Map<string, MyActivity>;

/** Target event id of a repost, reaction or reply. */
function targets(event: NostrEvent): string[] {
  return event.tags.filter((tag) => tag[0] === "e").map((tag) => tag[1]);
}

/**
 * Folds one author's own events (kinds 1, 5, 6, 7) into per-post state, so a
 * reload can rebuild exactly what the reader has already done. NIP-09
 * deletions win over the actions they delete.
 */
export function summarizeMyActivity(events: NostrEvent[]): MyActivityMap {
  const deleted = new Set<string>();
  for (const event of events) {
    if (event.kind !== DELETION_KIND) continue;
    // `k` narrows the kinds a deletion covers, but relays only index the `e`
    // tags, so every referenced id counts as removed.
    for (const id of targets(event)) deleted.add(id);
  }

  const map: MyActivityMap = new Map();
  const entry = (target: string): MyActivity => {
    let current = map.get(target);
    if (current === undefined) {
      current = {};
      map.set(target, current);
    }
    return current;
  };

  // Newest first, so the last write for a post wins.
  const ordered = [...events].sort((a, b) =>
    a.created_at !== b.created_at
      ? b.created_at - a.created_at
      : a.id < b.id
        ? 1
        : -1,
  );

  for (const event of ordered) {
    if (deleted.has(event.id)) continue;
    if (event.kind === REACTION_KIND) {
      for (const target of targets(event)) {
        entry(target).react ??= event.id;
      }
      continue;
    }
    if (event.kind === REPOST_KIND) {
      const quoted = event.tags.some((tag) => tag[0] === "q");
      for (const target of targets(event)) {
        const current = entry(target);
        if (quoted) {
          current.quote ??= event.id;
        } else {
          current.repost ??= event.id;
        }
      }
      continue;
    }
    if (event.kind === REPLY_KIND) {
      for (const target of targets(event)) {
        entry(target).replied = true;
      }
    }
  }
  return map;
}
