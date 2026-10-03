import type { UnsignedEvent } from "./auth.js";
import {
  compareEvents,
  hasValidId,
  hasValidSignature,
  isHex64,
  isValidEventStructure,
  type NostrEvent,
} from "./event.js";
import { mentionedProfiles } from "./profile-reference.js";

/**
 * Builders for the four post actions. Tag layouts follow the NIPs exactly,
 * because other clients read them to rebuild threads and notifications:
 *
 * - NIP-10 positional reply markers (`root`, `reply`)
 * - NIP-18 repost (`e`, `p`, `a`) and quote repost (adds `q`)
 * - NIP-25 reaction (`e`, `p`, `k`)
 * - NIP-27/NIP-22 `p` for anyone addressed in the text
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

/**
 * Every pubkey the text addresses, as `p` tags.
 *
 * NIP-27 asks for a mention to be written as a NIP-21 code — an `npub` or an
 * `nprofile` — and NIP-22 asks for everyone a reply names to carry a `p` tag,
 * which is what makes a relay notify them. Matching the text for anything but
 * bare hex meant a mention written the way the NIP says was read as naming
 * nobody, so the person written about was never told.
 *
 * The author is excluded: they are already tagged as the reply's target.
 */
export function mentionedPubkeys(text: string, exclude: string[]): string[] {
  const skip = new Set(exclude.filter((key) => key.length === 64));
  return mentionedProfiles(text).filter((key) => !skip.has(key));
}

/**
 * A thread root, known by id alone.
 *
 * The root event is not always in the cache: a reply opened from a deep link has
 * one whose root was never loaded, and the cache evicts under pressure. The id is
 * on the target's own `root` tag either way, and the id is all the `root` tag
 * requires. Answering a reply with the root event *or with nothing* made those
 * two cases indistinguishable here, and the nothing-branch marked the reply's own
 * target as the root — so every other client placed the reply at the top of a
 * thread whose root is a reply in the middle, and the real thread split in two.
 */
export interface RootRef {
  id: string;
  /** The root's author, when the event itself is held. */
  pubkey?: string;
}

export interface ReplyInput {
  pubkey: string;
  text: string;
  /** The post being answered. */
  target: NostrEvent;
  /** The thread root, when the target is itself a reply. */
  root?: NostrEvent | RootRef | null;
  createdAt: number;
}

/**
 * NIP-10 reply to one post.
 *
 * NIP-10's marked form is `["e", <event-id>, <relay-url>, <marker>, <pubkey>]`:
 * the marker is the **fourth** entry and the pubkey the fifth. Writing them the
 * other way round produces a reply that no current client can read — everyone
 * looks for the marker at index 3 and finds a pubkey there — so the reader would
 * treat the post as a fresh top-level note and drop the real thread root.
 *
 * When the target is a reply, the root is marked `root` and the target `reply`.
 * A reply to the root itself carries a **single** `root` tag, which is what
 * NIP-10 asks for and what marks it as a direct answer to that post.
 *
 * The target's own `p` tags come along, because NIP-10 says a reply's `p` tags
 * hold everyone already involved in the thread. Without them the people above
 * the reader in a conversation are not notified of it.
 */
export function buildReply(input: ReplyInput): UnsignedEvent {
  const { pubkey, target, root, text, createdAt } = input;
  const tags: string[][] = [];
  // A `p` tag may carry a relay hint and a petname after the key, and a relay
  // uses that hint to route the notification. So the target's own tag for
  // someone is the one that gets carried, not a bare pubkey written here: the
  // post being answered names its own author, and a reply that reduced that to a
  // key would strip the hint off the person it is answering.
  const carried = (key: string): string[] => {
    const own = target.tags.find((tag) => tag[0] === "p" && tag[1] === key);
    return own === undefined ? ["p", key] : [...own];
  };
  const rootId = root === undefined || root === null ? undefined : root.id;
  const rootPubkey = root?.pubkey;
  if (rootId !== undefined && rootId !== target.id) {
    // The pubkey is the fifth entry and NIP-10 recommends rather than requires
    // it, so a root known by id alone is written in the four-entry form rather
    // than with a hole where the author should be. Every client reads the marker
    // at the fourth position either way.
    tags.push(
      rootPubkey === undefined
        ? ["e", rootId, "", "root"]
        : ["e", rootId, "", "root", rootPubkey],
    );
    tags.push(["e", target.id, "", "reply", target.pubkey]);
    // The root's author is notified only when the root's event was held. It is
    // very likely among the target's own `p` tags, which are carried over below,
    // so a root known by id alone usually still reaches them — but not always, and
    // that is the trade: a root marker that is right, against possibly not
    // notifying one participant. The other order notified everyone and named the
    // wrong post as the root, which split the thread for every reader.
    if (rootPubkey !== undefined) tags.push(carried(rootPubkey));
    tags.push(carried(target.pubkey));
  } else {
    // A direct reply to the root: one marked tag, naming it as both the thread
    // it belongs to and the post being answered.
    tags.push(["e", target.id, "", "root", target.pubkey]);
    tags.push(carried(target.pubkey));
  }
  // Everyone else already in the thread, deduplicated against the tags above,
  // each carried over whole for the same reason.
  for (const tagged of target.tags) {
    if (tagged[0] !== "p" || tagged[1] === undefined) continue;
    if (tags.some((tag) => tag[0] === "p" && tag[1] === tagged[1])) continue;
    tags.push([...tagged]);
  }
  const a = addressTag(target);
  if (a !== null) tags.push(a);
  // Everyone the text names gets a `p` tag, which is what a relay notifies on.
  // The target's own tag is already there, so it is not added twice.
  for (const named of mentionedPubkeys(text, [target.pubkey])) {
    tags.push(["p", named]);
  }
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
  /**
   * A relay the target can be fetched from.
   *
   * NIP-18: "The repost event MUST include an `e` tag with the `id` of the note
   * that is being reposted. That tag MUST include a relay URL as its third entry
   * to indicate where it can be fetched." Written as `["e", id]` the tag had two
   * entries, so anything reading the third position found nothing and clients
   * fell back to guessing which of the reader's relays to ask — several of them
   * to none.
   *
   * Absent, the slot is filled with an empty string rather than the tag being
   * shortened: the URL *is* the third entry, so leaving it out puts the next
   * thing in its place.
   */
  relay?: string;
}): UnsignedEvent {
  const { pubkey, target, createdAt } = input;
  const tags: string[][] = [
    ["e", target.id, input.relay ?? ""],
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
  /** A relay the target can be fetched from; see `buildRepost`. */
  relay?: string;
}): UnsignedEvent {
  const base = buildRepost(input);
  const tags: string[][] = [
    // NIP-18's quote tag is `["q", "<event-id or address>", "<relay-url>",
    // "<pubkey-if-a-regular-event>"]`, so the relay goes in second here — the
    // same slot the `e` tag above carries it in third.
    [
      "q",
      base.tags[0][1],
      input.relay ?? "",
      typeof input.target.pubkey === "string" ? input.target.pubkey : "",
    ],
    ...base.tags,
  ];
  for (const named of mentionedPubkeys(input.text, [input.target.pubkey])) {
    tags.push(["p", named]);
  }
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
 * NIP-18 quote repost marker: `["q", <event-id>, <relay>, <pubkey>]`. Any
 * event may carry it, not only kind 6, so it is read from the tags alone.
 */
export function quoteTag(event: NostrEvent): string[] | undefined {
  return event.tags.find((tag) => tag[0] === "q");
}

/**
 * The event a post quotes, as a bare id. A `q` tag may instead hold an
 * address (`<kind>:<pubkey>:<d>`) for a replaceable event, which is not an
 * event id and cannot be looked up by `ids`, so it is reported as absent.
 */
export function quotedEventId(event: NostrEvent): string | null {
  const tag = quoteTag(event);
  const value = tag?.[1];
  return isHex64(value) ? value : null;
}

/**
 * The event a post reposts, taken from the NIP-18 `e` tag. Used for a plain
 * repost, whose content is empty by convention, so the quoted note has to be
 * fetched by id.
 */
export function repostedEventId(event: NostrEvent): string | null {
  if (event.kind !== REPOST_KIND) return null;
  const tag = event.tags.find((t) => t[0] === "e" && isHex64(t[1]));
  return tag === undefined ? null : tag[1];
}

/**
 * The event a post embeds, whichever way it points at it: a `q` tag for a
 * quote repost, the `e` tag for a plain repost. A kind 1 that quotes carries
 * `q` as well, so this covers quote notes as well as kind 6.
 */
export function embeddedEventId(event: NostrEvent): string | null {
  if (event.kind === REPOST_KIND) {
    // A kind 6 quotes with `q` and also carries the reposted id in `e`;
    // both name the same note, so either answer is correct.
    return quotedEventId(event) ?? repostedEventId(event);
  }
  return quotedEventId(event);
}

/**
 * NIP-18 allows a repost to carry the reposted note as JSON in its content,
 * which lets a client render the embed without a query. Returns the embedded
 * event only when it is structurally a valid event.
 */
/**
 * The note a NIP-18 repost carries in its own content.
 *
 * The id is checked as well as the shape, and so is the signature. This object
 * never crossed a socket, so nothing has vouched for it, and a repost's content
 * is attacker-chosen text: an inline note claiming someone else's id would be
 * drawn as that person's post, with words the attacker wrote, inside a card the
 * reader trusts.
 *
 * The id alone is not enough. It is the hash of the fields the author chose, and
 * `pubkey` is one of those fields, so an author who swaps in someone else's key
 * and recomputes the id produces a note that passes the id check while claiming
 * another person's name and avatar beside the attacker's words. Only the
 * signature says the named key signed it.
 */
export function embeddedNote(event: NostrEvent): NostrEvent | null {
  if (event.content.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (!isValidEventStructure(parsed) || !hasValidId(parsed)) return null;
  return hasValidSignature(parsed) ? parsed : null;
}

/**
 * A NIP-22 comment, which is either the dedicated kind or, from clients that
 * predate it, a kind 1 post carrying the uppercase `I` tag.
 *
 * Only the uppercase `I` marks a comment. In NIP-22 the uppercase tags (`K`,
 * `E`, `A`, `I`) are the root scope and the lowercase ones (`k`, `e`, `a`, `i`)
 * are the parent item, and a lowercase `i` is a NIP-73 external identifier — a
 * live tag any post may carry, such as `["i", "podcast:item:guid:…"]`. Treating
 * it as the comment marker would label an ordinary post a comment and drop it
 * from the Notes tab.
 */
export function isComment(event: NostrEvent): boolean {
  return (
    event.kind === COMMENT_KIND || event.tags.some((tag) => tag[0] === "I")
  );
}

/**
 * NIP-22 parent reference of a comment.
 *
 * NIP-22 writes the same shape for the root scope (uppercase `A`/`E`/`I`) and for
 * the parent item (lowercase `a`/`e`/`i`):
 *
 *     ["<A, E, I>", "<address, id or I-value>", "<relay or web page hint>", "<pubkey>"]
 *
 * Only the second entry is the reference, and it is there whether the tag has
 * three entries or four. Reading the tag as kind, pubkey and identifier joined
 * with colons produced a string that is neither an event id nor an address, so
 * nothing could query it; and requiring four entries meant every comment that
 * followed the spec's own two-entry examples — a URL comment, a podcast item —
 * was read as having no parent at all.
 *
 * The lowercase `i` is a NIP-73 external identifier for a live tag such as
 * `["i", "podcast:item:guid:…"]`, which is why a two-entry `i` is not treated as
 * a NIP-22 parent: a comment's own `i` names the kind of item it answers, and
 * the uppercase `I` is the one that carries the scope.
 *
 * Clients that predate the tag used a plain `e` tag, so that is still accepted.
 */
export function commentParent(event: NostrEvent): string | null {
  if (!isComment(event)) return null;
  // Uppercase is the root scope, which is what a comment replies to.
  const scoped = event.tags.find((tag) => tag[0] === "I" && tag.length >= 2);
  if (scoped !== undefined) return scoped[1];
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
 * The coordinate of an addressable event (`kind:pubkey:d`), or null.
 *
 * NIP-09 deletions name addressable events with `a` tags rather than `e`
 * tags, so matching a deletion against an event id alone never fires for
 * them. The coordinate is computed the same way `addressTag` writes it, so the
 * two always agree.
 */
export function eventAddress(event: NostrEvent): string | null {
  if (event.kind !== 30023 && event.kind !== 30024) return null;
  const d = event.tags.find((tag) => tag[0] === "d")?.[1];
  if (d === undefined) return null;
  return `${event.kind}:${event.pubkey}:${d}`;
}

/**
 * The coordinates a reader's own NIP-09 deletions name.
 *
 * NIP-09: deletion events carry "one or more `e` **or `a`** tags". Reading
 * only the `e` tags meant a deletion of an addressable event — a long-form
 * article, which NIP-09 deletes by coordinate — was collected and then matched
 * against nothing, so it never took effect.
 */
export function deletedAddresses(events: NostrEvent[]): Set<string> {
  const deleted = new Set<string>();
  for (const event of events) {
    if (event.kind !== DELETION_KIND) continue;
    for (const tag of event.tags) {
      if (tag[0] === "a" && typeof tag[1] === "string" && tag[1] !== "") {
        deleted.add(tag[1]);
      }
    }
  }
  return deleted;
}

/**
 * The event ids a reader's own NIP-09 deletions name.
 *
 * A deletion request does not remove anything on its own: relays that honour
 * NIP-09 drop the event, and the rest never send it again. A client that shows
 * what it loaded has to apply the deletions itself, which is what this is for.
 */
export function deletedEventIds(events: NostrEvent[]): Set<string> {
  const deleted = new Set<string>();
  for (const event of events) {
    if (event.kind !== DELETION_KIND) continue;
    // `k` narrows the kinds a deletion covers, but relays only index the `e`
    // tags, so every referenced id counts as removed.
    for (const id of targets(event)) deleted.add(id);
  }
  return deleted;
}

/**
 * Folds one author's own events (kinds 1, 5, 6, 7) into per-post state, so a
 * reload can rebuild exactly what the reader has already done. NIP-09
 * deletions win over the actions they delete.
 */
export function summarizeMyActivity(events: NostrEvent[]): MyActivityMap {
  const deleted = deletedEventIds(events);

  const map: MyActivityMap = new Map();
  const entry = (target: string): MyActivity => {
    let current = map.get(target);
    if (current === undefined) {
      current = {};
      map.set(target, current);
    }
    return current;
  };

  // Newest first, so the last write for a post wins. NIP-01 breaks timestamp
  // ties toward the lowest id, and the comparator here did the opposite — it
  // preferred the *highest* id — while also never returning `0`, which is not
  // an ordering. Both made the surviving action nondeterministic in exactly
  // the case relays produce on purpose.
  const ordered = [...events].sort(compareEvents);

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
