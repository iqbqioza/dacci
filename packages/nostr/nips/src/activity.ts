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
