import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { bech32Encode } from "./bech32.js";
import { computeEventId, type NostrEvent } from "./event.js";
import { encodeNpub } from "./nip19.js";
import {
  buildDeletion,
  commentParent,
  embeddedEventId,
  embeddedNote,
  isComment,
  buildQuoteRepost,
  buildReaction,
  buildReply,
  buildRepost,
  deletedEventIds,
  mentionedPubkeys,
  quotedEventId,
  quoteTag,
  repostedEventId,
  summarizeMyActivity,
} from "./activity.js";

const AT = 1_700_000_000;

/**
 * Real keys, so a test can produce a signature that actually verifies. A note
 * whose id matches its own fields but whose signature belongs to nobody is the
 * forgery `embeddedNote` has to refuse, and a fake 128-character string is not
 * enough to tell one apart from a real note.
 */
const ME_SECRET = "11".repeat(32);
const AUTHOR_SECRET = "22".repeat(32);
const ME = bytesToHex(schnorr.getPublicKey(hexToBytes(ME_SECRET)));
const AUTHOR = bytesToHex(schnorr.getPublicKey(hexToBytes(AUTHOR_SECRET)));
const ROOT_AUTHOR = "3".repeat(64);
/** Hex to bytes, two characters at a time. */
function hexBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

const SECRETS = new Map<string, string>([
  [ME, ME_SECRET],
  [AUTHOR, AUTHOR_SECRET],
]);

function note(
  id: string,
  pubkey: string,
  tags: string[][] = [],
): NostrEvent {
  const base = { pubkey, created_at: AT, kind: 1, tags, content: "x" };
  return { ...base, id, sig: "s".repeat(128) };
}

/** An unsigned event of any kind, for tag-shape tests. */
function buildComment(kind: number, tags: string[][]): NostrEvent {
  const base = { pubkey: ME, created_at: AT, kind, tags, content: "" };
  return { ...base, id: computeEventId(base), sig: "s".repeat(128) };
}

/**
 * A genuinely signed event: the signature is the named key's own, so a note that
 * only rewrites its own fields cannot pass for one that author published.
 */
function signed(
  kind: number,
  pubkey: string,
  tags: string[][],
  created_at: number,
): NostrEvent {
  const base = { pubkey, created_at, kind, tags, content: "" };
  const id = computeEventId(base);
  const secret = SECRETS.get(pubkey);
  if (secret === undefined) return { ...base, id, sig: "s".repeat(128) };
  return {
    ...base,
    id,
    sig: bytesToHex(schnorr.sign(hexToBytes(id), hexToBytes(secret))),
  };
}

const target = note("a".repeat(64), AUTHOR);
const root = note("b".repeat(64), ROOT_AUTHOR);

/**
 * NIP-10's marked form is `["e", <event-id>, <relay-url>, <marker>, <pubkey>]`,
 * so the marker is read at index 3. Looking for it anywhere else is what let the
 * writer and the reader disagree about the same tag.
 */
function tagValue(
  event: { tags: string[][] },
  name: string,
  marker?: string,
): string[] | undefined {
  return event.tags.find(
    (t) => t[0] === name && (marker === undefined || t[3] === marker),
  );
}

describe("buildReply", () => {
  it("gives a reply to the root a single root tag", () => {
    // NIP-10: "A direct reply to the root of a thread should have a single
    // marked 'e' tag of type 'root'." A lone root tag is also what tells a
    // reader that this post answers the root directly.
    const event = buildReply({
      pubkey: ME,
      text: "こんにちは",
      target,
      createdAt: AT,
    });
    expect(event.kind).toBe(1);
    expect(event.content).toBe("こんにちは");
    expect(tagValue(event, "e", "root")?.[1]).toBe(target.id);
    expect(tagValue(event, "e", "reply")).toBeUndefined();
    const marked = event.tags.filter((t: string[]) => t[0] === "e");
    expect(marked).toHaveLength(1);
    expect(tagValue(event, "p")?.[1]).toBe(AUTHOR);
  });

  it("names the root by id even when the root event is not held", () => {
    // The miss is routine: a reply opened from a deep link has one whose root was
    // never loaded, and the cache evicts under pressure. Answering `null` there
    // was indistinguishable from "this post is its own thread's root", so the
    // reply marked its own target as the root — every client then placed it at the
    // top of a thread rooted in a reply from the middle of the real one, and the
    // real thread split in two.
    //
    // The id is on the target's own `root` tag, so it is known either way, and it
    // is all the tag requires.
    const event = buildReply({
      pubkey: ME,
      text: "x",
      target,
      root: { id: root.id },
      createdAt: AT,
    });
    // Still the root, still the reply — the two marked tags, with the marker in
    // the position NIP-10 says to read it from.
    expect(tagValue(event, "e", "root")?.[1]).toBe(root.id);
    expect(tagValue(event, "e", "reply")?.[1]).toBe(target.id);
    // Four entries rather than five: the pubkey is recommended, not required, and
    // a hole where the author should be is worse than its absence.
    const rootTag = event.tags.find((t) => t[1] === root.id);
    expect(rootTag).toEqual(["e", root.id, "", "root"]);
    // What is given up: the root's author is not named by a `p` tag, so this
    // reply does not notify them. It is very likely among the target's own `p`
    // tags — NIP-10 says a reply carries everyone already in the thread — but not
    // guaranteed, and not here, where the target names nobody.
    //
    // That is the trade: a root marker that is right, at the cost of possibly not
    // notifying one participant when the root event was not in the cache. The
    // other order notified everyone and marked the wrong post as the root, which
    // split the thread for every reader.
    expect(
      event.tags.some((t) => t[0] === "p" && t[1] === ROOT_AUTHOR),
    ).toBe(false);
    // And the target's author, who is in hand, is notified as before.
    expect(tagValue(event, "p")?.[1]).toBe(AUTHOR);
  });

  it("marks its own target as the root only when the target really is one", () => {
    // The other half, and the one a fix written as "always write two marked
    // tags" would break: a direct reply to a thread's root carries a *single*
    // `root` tag, which is what NIP-10 asks for.
    const direct = buildReply({
      pubkey: ME,
      text: "x",
      target,
      root: { id: target.id, pubkey: AUTHOR },
      createdAt: AT,
    });
    expect(direct.tags.filter((t) => t[0] === "e")).toHaveLength(1);
    expect(tagValue(direct, "e", "root")?.[1]).toBe(target.id);
    expect(tagValue(direct, "e", "reply")).toBeUndefined();
  });

  it("puts the marker where NIP-10 says to read it", () => {
    // The whole tag: id, then the relay hint (left empty), then the marker,
    // then the author. Reading the marker at any other index is what made a
    // published reply unreadable to every current client.
    const deep = buildReply({ pubkey: ME, text: "x", target, root, createdAt: AT });
    const rootTag = deep.tags.find((t) => t[1] === root.id);
    expect(rootTag).toEqual(["e", root.id, "", "root", ROOT_AUTHOR]);
    const replyTag = deep.tags.find((t) => t[1] === target.id);
    expect(replyTag).toEqual(["e", target.id, "", "reply", AUTHOR]);
  });

  it("carries the people already in the thread along", () => {
    // NIP-10: the reply's `p` tags hold everyone involved in the thread, so
    // those above the reader are notified of it too.
    const deep = note("d".repeat(64), AUTHOR, [["p", "9".repeat(64)]]);
    const event = buildReply({
      pubkey: ME,
      text: "x",
      target: deep,
      root,
      createdAt: AT,
    });
    const authors = event.tags.filter((t) => t[0] === "p").map((t) => t[1]);
    expect(authors).toEqual([ROOT_AUTHOR, AUTHOR, "9".repeat(64)]);
  });

  it("keeps the thread root separate when replying to a reply", () => {
    const event = buildReply({
      pubkey: ME,
      text: "同意",
      target,
      root,
      createdAt: AT,
    });
    expect(tagValue(event, "e", "root")?.[1]).toBe(root.id);
    expect(tagValue(event, "e", "reply")?.[1]).toBe(target.id);
    const authors = event.tags
      .filter((t: string[]) => t[0] === "p")
      .map((t: string[]) => t[1]);
    expect(authors).toEqual([ROOT_AUTHOR, AUTHOR]);
  });

  it("tags the author named in the text, so a relay notifies them", () => {
    // A `p` tag is what NIP-22 and current NIP-27 ask for. The legacy
    // `mentions` tag was written for a spelling of the mention no longer in the
    // NIP, and nothing acted on it.
    const event = buildReply({
      pubkey: ME,
      text: `nostr:${encodeNpub(AUTHOR)} さんへ`,
      target,
      createdAt: AT,
    });
    const tagged = event.tags.filter((tag) => tag[0] === "p").map((tag) => tag[1]);
    // The target is tagged because it is being answered, and the author named in
    // the text is tagged because they were written about.
    expect(tagged).toContain(AUTHOR);
  });

  it("carries a thread's p tags over whole, hint and petname included", () => {
    // A `p` tag may carry a relay hint and a petname after the key. Reducing it
    // to a bare pubkey when a reply is published quietly strips both from
    // everyone else in the conversation — and the relay hint is what a relay
    // uses to route the notification.
    const third = "4".repeat(64);
    const inThread = note("e".repeat(64), AUTHOR, [
      ["p", AUTHOR],
      ["p", third, "wss://relay.example", "bob"],
    ]);
    const event = buildReply({
      pubkey: ME,
      text: "その記事を読んだ",
      target: inThread,
      createdAt: AT,
    });
    expect(event.tags.find((tag) => tag[0] === "p" && tag[1] === third)).toEqual([
      "p",
      third,
      "wss://relay.example",
      "bob",
    ]);
  });

  it("keeps the hint the post being answered wrote for its own author", () => {
    // The target names its own author, and that tag may carry the hint. A reply
    // writing a bare pubkey instead strips it off the person it is answering.
    const withHint = note("f".repeat(64), AUTHOR, [
      ["p", AUTHOR, "wss://author.example", "self"],
    ]);
    const event = buildReply({
      pubkey: ME,
      text: "ふむ",
      target: withHint,
      createdAt: AT,
    });
    expect(event.tags.find((tag) => tag[0] === "p" && tag[1] === AUTHOR)).toEqual([
      "p",
      AUTHOR,
      "wss://author.example",
      "self",
    ]);
  });

  it("adds a NIP-18 address tag for a long-form post", () => {
    const article = note("c".repeat(64), AUTHOR, [["d", "my-article"]]);
    article.kind = 30023;
    const event = buildReply({
      pubkey: ME,
      text: "良い記事",
      target: article,
      createdAt: AT,
    });
    expect(tagValue(event, "a")?.[1]).toBe(`30023:${AUTHOR}:my-article`);
  });
});

describe("buildRepost", () => {
  it("references the reposted event and its author", () => {
    const event = buildRepost({ pubkey: ME, target, createdAt: AT });
    expect(event.kind).toBe(6);
    expect(event.content).toBe("");
    expect(tagValue(event, "e")?.[1]).toBe(target.id);
    expect(tagValue(event, "p")?.[1]).toBe(AUTHOR);
  });

  it("names a relay the note can be fetched from, where NIP-18 says it must", () => {
    // "The repost event MUST include an `e` tag with the `id` of the note that is
    // being reposted. That tag MUST include a relay URL as its third entry to
    // indicate where it can be fetched."
    //
    // The tag used to be written as `["e", id]`, so the third entry did not exist
    // and clients that read it fell back to guessing which relay to ask.
    const tagged = buildRepost({
      pubkey: ME,
      target,
      createdAt: AT,
      relay: "wss://relay.example/",
    });
    expect(tagValue(tagged, "e")?.[2]).toBe("wss://relay.example/");

    // With no relay to name, the slot is still there. Shortening the tag instead
    // puts whatever a client reads next into the relay's place.
    const unnamed = buildRepost({ pubkey: ME, target, createdAt: AT });
    const tag = tagValue(unnamed, "e") as string[];
    expect(tag).toHaveLength(3);
    expect(tag[2]).toBe("");
  });
});

describe("buildQuoteRepost", () => {
  it("adds the q tag and keeps the quoter text", () => {
    const event = buildQuoteRepost({
      pubkey: ME,
      target,
      text: "これ読んで",
      createdAt: AT,
    });
    expect(event.kind).toBe(6);
    expect(event.content).toBe("これ読んで");
    expect(tagValue(event, "q")?.[1]).toBe(target.id);
    expect(tagValue(event, "e")?.[1]).toBe(target.id);
  });

  it("gives the q tag the relay and the pubkey NIP-18 names", () => {
    // `["q", "<event-id or address>", "<relay-url>", "<pubkey-if-a-regular-event>"]`
    const event = buildQuoteRepost({
      pubkey: ME,
      target,
      text: "これ読んで",
      createdAt: AT,
      relay: "wss://relay.example/",
    });
    const q = tagValue(event, "q") as string[];
    expect(q[0]).toBe("q");
    expect(q[1]).toBe(target.id);
    expect(q[2]).toBe("wss://relay.example/");
    expect(q[3]).toBe(AUTHOR);
    // And the `e` tag carries the same relay in its own third entry.
    expect(tagValue(event, "e")?.[2]).toBe("wss://relay.example/");
  });
});

describe("buildReaction", () => {
  it("uses the NIP-25 layout with a plus symbol", () => {
    const event = buildReaction({ pubkey: ME, target, createdAt: AT });
    expect(event.kind).toBe(7);
    expect(event.content).toBe("+");
    expect(tagValue(event, "e")?.[1]).toBe(target.id);
    expect(tagValue(event, "p")?.[1]).toBe(AUTHOR);
    expect(tagValue(event, "k")?.[1]).toBe("+");
  });

  it("carries a custom symbol", () => {
    const event = buildReaction({
      pubkey: ME,
      target,
      createdAt: AT,
      symbol: "🤙",
    });
    expect(event.content).toBe("🤙");
    expect(tagValue(event, "k")?.[1]).toBe("🤙");
  });
});

describe("mentionedPubkeys", () => {
  it("reads a mention written the way NIP-27 asks", () => {
    // NIP-27 writes a mention as a NIP-21 code. Matching the text for bare hex
    // instead meant the spelling the NIP prescribes was read as naming nobody,
    // so the person written about was never tagged and never notified.
    const profile = bech32Encode("nprofile", new Uint8Array([0, 32, ...hexBytes(AUTHOR)]));
    expect(mentionedPubkeys(`hi nostr:${encodeNpub(AUTHOR)}`, [])).toEqual([AUTHOR]);
    expect(mentionedPubkeys(`hi nostr:${profile}`, [])).toEqual([AUTHOR]);
    expect(mentionedPubkeys("nothing here", [])).toEqual([]);
  });

  it("leaves out whoever is already tagged, and does not read a bare key", () => {
    // The reply's own target already has a `p` tag, so it is not added twice.
    expect(mentionedPubkeys(`hi nostr:${encodeNpub(AUTHOR)}`, [AUTHOR])).toEqual([]);
    // A bare 64-hex key in a post is as likely to be something pasted for
    // looking up as a person being written about.
    expect(mentionedPubkeys(`hi ${AUTHOR}`, [])).toEqual([]);
  });
});

describe("isComment", () => {
  it("recognises the dedicated NIP-22 kind", () => {
    expect(isComment(buildComment(1111, [["e", "f".repeat(64)]]))).toBe(true);
  });

  it("recognises a kind 1 comment that carries an I tag", () => {
    // Clients before the dedicated kind posted comments as kind 1 with
    // the uppercase I tag; those are comments all the same.
    expect(isComment(buildComment(1, [["I", "30023", AUTHOR, "post"]]))).toBe(
      true,
    );
    // The lowercase `i` is not the same tag. In NIP-22 the lowercase tags are
    // the parent item and the uppercase ones are the root scope, and a
    // lowercase `i` is a NIP-73 external identifier any post may carry — a
    // podcast episode's guid, say. Reading it as the comment marker labels an
    // ordinary post a comment and drops it from the Notes tab.
    expect(isComment(buildComment(1, [["i", "30023", AUTHOR, "post"]]))).toBe(
      false,
    );
    expect(
      isComment(
        buildComment(1, [["i", "podcast:item:guid:d98e07d4-9f8b-4c1b-9b04-e0d0e4b0a3a1"]]),
      ),
    ).toBe(false);
  });

  it("leaves ordinary notes and replies alone", () => {
    expect(isComment(buildComment(1, []))).toBe(false);
    expect(isComment(buildComment(1, [["e", "f".repeat(64)], ["p", AUTHOR]]))).toBe(
      false,
    );
  });
});

describe("commentParent", () => {
  it("reads the reference out of the NIP-22 I tag", () => {
    // NIP-22 gives every scope tag the same shape:
    // ["<A, E, I>", "<reference>", "<relay or web hint>", "<pubkey>"].
    // The second entry is the reference; joining the rest with colons produced a
    // string that is neither an event id nor an address, so nothing could query
    // it.
    const event = buildComment(1111, [
      ["I", `30023:${AUTHOR}:my-article`, "wss://example.relay", AUTHOR],
      ["p", ME],
    ]);
    expect(commentParent(event)).toBe(`30023:${AUTHOR}:my-article`);
  });

  it("reads the two-entry form the spec's own examples use", () => {
    // A URL comment and a podcast item are the two NIP-22 writes out, and both
    // stop after the reference. Requiring a fourth entry read every one of them
    // as having no parent at all.
    const url = buildComment(1111, [
      ["I", "https://abc.com/articles/1"],
      ["K", "web"],
      ["i", "https://abc.com/articles/1"],
      ["k", "web"],
    ]);
    expect(commentParent(url)).toBe("https://abc.com/articles/1");

    const podcast = buildComment(1111, [
      ["I", "podcast:item:guid:d98d", "https://fountain.fm/episode/1"],
      ["K", "podcast:item"],
    ]);
    expect(commentParent(podcast)).toBe("podcast:item:guid:d98d");
  });

  it("takes the root scope, not a live tag's lowercase i", () => {
    // A lowercase `i` is a NIP-73 external identifier on an ordinary post
    // (`["i", "podcast:item:guid:…"]`), so it is never the parent. The uppercase
    // `I` is the scope a comment replies to.
    const event = buildComment(1111, [
      ["I", "30023:pk:d"],
      ["i", "1", ME, "parent-item"],
    ]);
    expect(commentParent(event)).toBe("30023:pk:d");
  });

  it("falls back to the legacy e tag", () => {
    const event = buildComment(1111, [["e", "f".repeat(64)]]);
    expect(commentParent(event)).toBe("f".repeat(64));
  });

  it("returns null for a non-comment or a parentless comment", () => {
    expect(commentParent(buildComment(1, [["e", "f".repeat(64)]]))).toBeNull();
    expect(commentParent(buildComment(1111, []))).toBeNull();
    // A live tag on its own does not make a comment either.
    expect(commentParent(buildComment(1111, [["i", "podcast:item:guid:x"]]))).toBeNull();
  });

  it("finds the parent of a kind 1 comment too", () => {
    const event = buildComment(1, [["I", `30023:${AUTHOR}:my-article`]]);
    expect(commentParent(event)).toBe(`30023:${AUTHOR}:my-article`);
  });
});

describe("buildDeletion", () => {
  it("references the deleted events and their kinds", () => {
    const event = buildDeletion({
      pubkey: ME,
      eventIds: ["d".repeat(64)],
      kinds: [7],
      createdAt: AT,
    });
    expect(event.kind).toBe(5);
    expect(event.content).toBe("");
    expect(event.tags).toEqual([
      ["k", "7"],
      ["e", "d".repeat(64)],
    ]);
  });

  it("omits k when the deletion covers every kind", () => {
    const event = buildDeletion({
      pubkey: ME,
      eventIds: ["d".repeat(64)],
      createdAt: AT,
    });
    expect(event.tags).toEqual([["e", "d".repeat(64)]]);
  });
});

describe("deletedEventIds", () => {
  const one = "1".repeat(64);
  const two = "2".repeat(64);

  it("names every event a deletion request references", () => {
    // A request removes nothing by itself: relays that honour NIP-09 drop the
    // event, and the client has to take it off screen itself.
    const events = [
      note(one, AUTHOR),
      signed(5, ME, [["e", one]], 2000),
    ];
    expect([...deletedEventIds(events)]).toEqual([one]);
  });

  it("counts every referenced id even when k narrows the kinds", () => {
    // Relays index the `e` tags and ignore `k` when deciding what is gone, so
    // a client reading the same way does not show a post a relay has dropped.
    const events = [
      note(one, AUTHOR),
      note(two, AUTHOR),
      signed(5, ME, [["k", "7"], ["e", one], ["e", two]], 2000),
    ];
    expect([...deletedEventIds(events)]).toEqual([one, two]);
  });

  it("finds nothing when there is no deletion among the events", () => {
    expect(deletedEventIds([note(one, AUTHOR)]).size).toBe(0);
  });

  it("takes the same ids the activity summary uses, so both agree", () => {
    const reactionEvent = signed(7, ME, [["e", one, "", AUTHOR]], 1000);
    const events = [
      reactionEvent,
      signed(5, ME, [["e", reactionEvent.id]], 2000),
    ];
    expect([...deletedEventIds(events)]).toEqual([reactionEvent.id]);
    // The reaction was deleted, so no action is remembered for it.
    expect(summarizeMyActivity(events).size).toBe(0);
  });
});

describe("summarizeMyActivity", () => {
  const targetId = "1".repeat(64);
  const otherId = "2".repeat(64);
  const at = (n: number) => 1000 + n;

  const reaction = signed(7, ME, [
    ["e", targetId],
    ["k", "+"],
  ], at(1));
  const repost = signed(6, ME, [["e", targetId]], at(2));
  const quote = signed(6, ME, [["e", targetId], ["q", targetId]], at(3));
  const reply = signed(1, ME, [
    ["e", targetId, "", "root", AUTHOR],
    ["p", AUTHOR],
  ], at(4));

  it("records each action against its post", () => {
    const map = summarizeMyActivity([reaction, repost, quote, reply]);
    expect(map.get(targetId)).toEqual({
      react: reaction.id,
      repost: repost.id,
      quote: quote.id,
      replied: true,
    });
    expect(map.size).toBe(1);
  });

  it("a NIP-09 deletion removes the action it targets", () => {
    const deletion = signed(5, ME, [["k", "7"], ["e", reaction.id]], at(5));
    const map = summarizeMyActivity([reaction, repost, deletion]);
    expect(map.get(targetId)?.react).toBeUndefined();
    // The repost survives: only the reaction was deleted.
    expect(map.get(targetId)?.repost).toBe(repost.id);
  });

  it("keeps the newest reaction when several exist", () => {
    const older = signed(7, ME, [["e", targetId]], at(1));
    const newer = signed(7, ME, [["e", targetId]], at(9));
    expect(summarizeMyActivity([older, newer]).get(targetId)?.react).toBe(
      newer.id,
    );
    expect(summarizeMyActivity([newer, older]).get(targetId)?.react).toBe(
      newer.id,
    );
  });

  it("separates posts so one card never shows another's state", () => {
    const other = signed(7, ME, [["e", otherId]], at(1));
    const map = summarizeMyActivity([reaction, other]);
    expect(map.get(targetId)?.react).toBe(reaction.id);
    expect(map.get(otherId)?.react).toBe(other.id);
  });

  it("marks replies from the thread tags", () => {
    const map = summarizeMyActivity([reply]);
    expect(map.get(targetId)?.replied).toBe(true);
    expect(map.get(targetId)?.react).toBeUndefined();
  });
});

describe("quote and repost references", () => {
  const quoted = "9".repeat(64);
  const reposted = "8".repeat(64);

  it("reads the NIP-18 q tag of a quote repost", () => {
    const event = buildComment(6, [["q", quoted, "wss://relay", AUTHOR]]);
    expect(quoteTag(event)).toEqual(["q", quoted, "wss://relay", AUTHOR]);
    expect(quotedEventId(event)).toBe(quoted);
  });

  it("reads the e tag of a plain repost", () => {
    const event = buildComment(6, [["e", reposted, "wss://relay"], ["p", AUTHOR]]);
    expect(repostedEventId(event)).toBe(reposted);
    // A plain repost quotes nothing.
    expect(quotedEventId(event)).toBeNull();
  });

  it("resolves the embed of both repost shapes", () => {
    expect(embeddedEventId(buildComment(6, [["e", reposted]]))).toBe(reposted);
    expect(
      embeddedEventId(buildComment(6, [["q", quoted], ["e", quoted], ["p", AUTHOR]])),
    ).toBe(quoted);
  });

  it("embeds a quote note, which is a kind 1 carrying only q", () => {
    expect(embeddedEventId(buildComment(1, [["q", quoted]]))).toBe(quoted);
  });

  it("reports nothing for a post that embeds no other post", () => {
    expect(embeddedEventId(buildComment(1, []))).toBeNull();
    expect(embeddedEventId(buildComment(1, [["e", "7".repeat(64)]]))).toBeNull();
    expect(repostedEventId(buildComment(1, [["e", reposted]]))).toBeNull();
  });

  it("ignores a q tag holding an address, which is not an event id", () => {
    const event = buildComment(6, [["q", "30023:" + AUTHOR + ":my-article"]]);
    expect(quotedEventId(event)).toBeNull();
    // The e tag still names the reposted note, so the embed resolves.
    expect(embeddedEventId(buildComment(6, [["q", "30023:" + AUTHOR + ":a"], ["e", reposted]]))).toBe(
      reposted,
    );
  });

  it("ignores a malformed e tag on a repost", () => {
    expect(repostedEventId(buildComment(6, [["e", "not-an-id"]]))).toBeNull();
  });

  it("unwraps the note a repost embeds in its content", () => {
    // The inline note's id has to follow from its own fields: the content of a
    // repost is attacker-chosen text that never crossed a socket, so the id is
    // the only thing tying it to the note it claims to be.
    const inner = signed(1, AUTHOR, [["t", "nostr"]], AT);
    const repost: NostrEvent = {
      id: "c".repeat(64),
      pubkey: ME,
      created_at: AT,
      kind: 6,
      tags: [["e", inner.id], ["p", AUTHOR]],
      content: JSON.stringify(inner),
      sig: "s".repeat(128),
    };
    expect(embeddedNote(repost)).toEqual(inner);
  });

  it("refuses an inline note whose id is not the hash of its own fields", () => {
    // A repost is signed by whoever wrote it, so the outer event passes every
    // check and still says whatever it likes about the note inside. Without the
    // id check the feed draws a card that looks like the victim's own post and
    // contains words the attacker typed.
    const victim = signed(1, AUTHOR, [], AT);
    const repost: NostrEvent = {
      id: "c".repeat(64),
      pubkey: ME,
      created_at: AT,
      kind: 6,
      tags: [["e", victim.id], ["p", AUTHOR]],
      content: JSON.stringify({ ...victim, content: "TRUST ME" }),
      sig: "s".repeat(128),
    };
    expect(embeddedNote(repost)).toBeNull();
  });

  it("refuses an inline note that borrows another author's name", () => {
    // The attack the id check does not see. `pubkey` is one of the fields the
    // id is computed over, so an author who writes a note under someone else's
    // key and recomputes the id produces a note whose id matches perfectly. The
    // feed would then draw that person's real avatar and display name next to
    // words the attacker typed, inside a card the reader trusts. Only the
    // signature says the named key signed it.
    const victim = signed(1, AUTHOR, [], AT);
    const stolen = {
      pubkey: AUTHOR,
      created_at: AT,
      kind: 1,
      tags: [],
      content: "this is not what they said",
    };
    // Same fields, a correct id, and a signature that belongs to the attacker.
    const forgery: NostrEvent = {
      ...stolen,
      id: computeEventId(stolen),
      sig: bytesToHex(schnorr.sign(hexToBytes(computeEventId(stolen)), hexToBytes(ME_SECRET))),
    };
    expect(forgery.id === computeEventId(forgery)).toBe(true);
    const repost: NostrEvent = {
      id: "c".repeat(64),
      pubkey: ME,
      created_at: AT,
      kind: 6,
      tags: [["e", forgery.id], ["p", AUTHOR]],
      content: JSON.stringify(forgery),
      sig: "s".repeat(128),
    };
    expect(embeddedNote(repost)).toBeNull();
    // The genuine note by that author is still unwrapped.
    const honest: NostrEvent = {
      id: "d".repeat(64),
      pubkey: ME,
      created_at: AT,
      kind: 6,
      tags: [["e", victim.id], ["p", AUTHOR]],
      content: JSON.stringify(victim),
      sig: "s".repeat(128),
    };
    expect(embeddedNote(honest)).toEqual(victim);
  });

  it("has no embedded note when the content is prose or broken JSON", () => {
    expect(embeddedNote(buildComment(6, []))).toBeNull();
    const prose = { ...buildComment(6, [["e", quoted]]), content: "just words" };
    expect(embeddedNote(prose)).toBeNull();
    const broken = { ...buildComment(6, [["e", quoted]]), content: "{not json" };
    expect(embeddedNote(broken)).toBeNull();
  });

  it("rejects a content blob that is JSON but not an event", () => {
    const blob = { ...buildComment(6, [["e", quoted]]), content: '{"hello":"world"}' };
    expect(embeddedNote(blob)).toBeNull();
  });

  it("never treats a quote repost as an ordinary note", () => {
    const quote = buildQuoteRepost({
      pubkey: ME,
      target: note(reposted, AUTHOR),
      text: "worth reading",
      createdAt: AT,
    });
    expect(quote.content).toBe("worth reading");
    expect(embeddedEventId({ ...quote, id: "d".repeat(64), sig: "s".repeat(128) })).toBe(
      reposted,
    );
  });
});

describe("event integrity", () => {
  it("produces an unsigned template with a stable id", () => {
    const event = buildReaction({ pubkey: ME, target, createdAt: AT });
    expect(computeEventId(event)).toBe(computeEventId({ ...event }));
    // Builders never sign; the signer adds the signature.
    expect("sig" in event).toBe(false);
  });
});
