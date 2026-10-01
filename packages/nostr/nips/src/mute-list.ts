import type { UnsignedEvent } from "./auth.js";
import { isHex64, type NostrEvent } from "./event.js";

/**
 * NIP-51 mute list kind. A standard list, so it is a replaceable event: the
 * reader has exactly one, and every change republishes it whole.
 *
 * The NIP names it "things the user doesn't want to see in their feeds", which
 * is exactly the scope a client may claim: hiding a post on this device is all
 * a mute can ever do, because the event stays on the relays and every other
 * client is free to show it.
 */
export const MUTE_LIST_KIND = 10000;

/**
 * The list's tags, exactly as they were written.
 *
 * Everything is kept, not only the `p` tags, because a mute list may also hold
 * hashtags, words and threads, and republishing the list to add one person would
 * otherwise delete all of those. NIP-51 asks for new items to be appended, so
 * the list keeps the order the reader built it in.
 */
export function muteTags(event: NostrEvent | null): string[][] {
  if (event === null || event.kind !== MUTE_LIST_KIND) return [];
  return event.tags.filter((tag) => Array.isArray(tag));
}

/** Whether the list holds this person. */
export function mutedIn(tags: string[][], pubkey: string): boolean {
  return tags.some((tag) => tag[0] === "p" && tag[1] === pubkey);
}

/** The people a mute list names, in order and without repeats. */
export function mutedPubkeys(tags: string[][]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const key = tag[1];
    if (tag[0] !== "p" || !isHex64(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * A mute list with one person muted or unmuted, and every other tag left where
 * it was. Unmuting drops every entry for that person, because a list that names
 * someone twice still mutes them.
 */
export function withMuted(
  tags: string[][],
  pubkey: string,
  muted: boolean,
): string[][] {
  if (muted && mutedIn(tags, pubkey)) return tags;
  const rest = tags.filter((tag) => !(tag[0] === "p" && tag[1] === pubkey));
  return muted ? [...rest, ["p", pubkey]] : rest;
}

/** NIP-51 mute list to publish. The content is empty; nothing private is in it. */
export function buildMuteList(input: {
  pubkey: string;
  tags: string[][];
  createdAt: number;
}): UnsignedEvent {
  return {
    pubkey: input.pubkey,
    created_at: input.createdAt,
    kind: MUTE_LIST_KIND,
    tags: input.tags,
    content: "",
  };
}