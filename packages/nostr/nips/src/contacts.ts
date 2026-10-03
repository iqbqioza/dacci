import type { UnsignedEvent } from "./auth.js";
import { isHex64, type NostrEvent } from "./event.js";

/** NIP-02 follow list (contacts) kind. */
export const CONTACTS_KIND = 3;

/**
 * Parse a NIP-02 contacts event into followed pubkeys.
 * Only exact 64-char lowercase hex "p" tags count; duplicates collapse.
 */
export function parseContacts(event: NostrEvent): string[] {
  return contactPubkeys(contactTags(event));
}

/**
 * The `p` tags of a follow list, exactly as they were written. A `p` tag may
 * carry a relay hint and a petname after the pubkey, so the tags are kept
 * whole rather than reduced to keys: republishing the list has to carry those
 * along, or following one more person would quietly strip them from everyone
 * else.
 */
export function contactTags(event: NostrEvent | null): string[][] {
  if (event === null || event.kind !== CONTACTS_KIND) return [];
  return event.tags.filter(
    (tag) => Array.isArray(tag) && tag[0] === "p" && isHex64(tag[1]),
  );
}

/** The pubkeys a list of `p` tags names, in order and without repeats. */
export function contactPubkeys(tags: string[][]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const key = tag[1];
    if (!isHex64(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Whether a follow list names this person.
 *
 * Held to a value NIP-01 allows in a `p` tag, like every other reader of this
 * list: `contactPubkeys` and `withFollowed` both refuse a non-hex key, the last
 * because writing one publishes a follow nobody honours. Gated here as well so
 * the device and the account agree — otherwise a list naming `["p", "alice"]`
 * read as *followed* here while every client, and this app's own enumerator,
 * read it as not naming anyone at all.
 */
export function followsIn(tags: string[][], pubkey: string): boolean {
  return (
    isHex64(pubkey) && tags.some((tag) => tag[0] === "p" && tag[1] === pubkey)
  );
}

/**
 * A follow list with one person followed or unfollowed, and every other entry
 * left where it was. NIP-02 has no event for a single follow: the list is one
 * replaceable event, so adding a name means publishing the whole list again.
 *
 * Unfollowing drops every entry for that person, because a list that names
 * someone twice is still a list that follows them.
 */
export function withFollowed(
  tags: string[][],
  pubkey: string,
  followed: boolean,
): string[][] {
  // Same refusal as the mute list: a non-hex `p` value publishes a follow no
  // other client honors while this one shows it as done. Removal is exempt,
  // as there: dropping garbage is hygiene.
  if (followed && !isHex64(pubkey)) return tags;
  const already = followsIn(tags, pubkey);
  // Someone already in the list keeps their place in it and their relay hint.
  if (followed && already) return tags;
  // Unfollowing drops every entry, because a list that names someone twice is
  // still a list that follows them.
  const rest = tags.filter((tag) => !(tag[0] === "p" && tag[1] === pubkey));
  return followed ? [...rest, ["p", pubkey]] : rest;
}

/**
 * NIP-02 follow list to publish. The content is empty, which NIP-02 allows:
 * it is only used by clients that record which relays a list was built with.
 */
export function buildFollowList(input: {
  pubkey: string;
  tags: string[][];
  createdAt: number;
}): UnsignedEvent {
  return {
    pubkey: input.pubkey,
    created_at: input.createdAt,
    kind: CONTACTS_KIND,
    tags: input.tags,
    content: "",
  };
}