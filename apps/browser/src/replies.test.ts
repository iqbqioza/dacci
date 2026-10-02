import { COMMENT_KIND, type NostrEvent } from "dacci-nostr-nips";
import { describe, expect, it } from "vitest";
import { directReplies, isDirectReply, commentReplyParent, replyParent } from "./replies.js";

function post(
  id: string,
  tags: string[][] = [],
  kind = 1,
  createdAt = 1000,
): NostrEvent {
  return {
    id,
    pubkey: "a".repeat(64),
    created_at: createdAt,
    kind,
    tags,
    content: "x",
    sig: "s".repeat(128),
  };
}

const ROOT = "1".repeat(64);
const MIDDLE = "2".repeat(64);
const LEAF = "3".repeat(64);

describe("replyParent", () => {
  it("reads the NIP-10 reply marker as the direct parent", () => {
    // `reply` is deliberately not the last tag. The marker decides which post
    // is answered; position only decides for the deprecated form, so a fixture
    // that put the answer last would pass even with the marker unread.
    const reply = post(MIDDLE, [
      ["e", LEAF, "", "reply", "a".repeat(64)],
      ["e", ROOT, "", "root", "a".repeat(64)],
    ]);
    expect(replyParent(reply)).toBe(LEAF);
  });

  it("treats a lone root marker as answering the root directly", () => {
    // NIP-10 prescribes exactly this for a top-level reply: one marked `e` tag
    // of type `root`.
    //
    // The unmarked tag after it is what makes the assertion mean something. Read
    // by position, the last `e` would be the answer and this would pass with the
    // root marker never consulted — so the two rules disagree here on purpose.
    const reply = post(MIDDLE, [
      ["e", ROOT, "", "root", "a".repeat(64)],
      ["e", LEAF],
    ]);
    expect(replyParent(reply)).toBe(ROOT);
  });

  it("falls back to the last tag for the deprecated positional form", () => {
    const reply = post(MIDDLE, [
      ["e", ROOT],
      ["e", LEAF],
    ]);
    expect(replyParent(reply)).toBe(LEAF);
  });

  it("reports nothing for a post that answers no one", () => {
    expect(replyParent(post(MIDDLE))).toBeNull();
    expect(replyParent(post(MIDDLE, [["p", "a".repeat(64)]]))).toBeNull();
  });

  it("ignores an e tag that is not an event id", () => {
    // A quote or an address is not a parent, so it must not be read as one.
    const reply = post(MIDDLE, [["e", "30023:abc:slug"]]);
    expect(replyParent(reply)).toBeNull();
  });

  it("reports nothing for a post that only mentions another one", () => {
    // NIP-10's third marker is a reference, not an answer. Without this the
    // marker falls through to the positional form and the mention is read as
    // the parent, so the post shows up as a reply to what it points at.
    const quoting = post(MIDDLE, [["e", ROOT, "", "mention", "a".repeat(64)]]);
    expect(replyParent(quoting)).toBeNull();
  });

  it("still takes the positional parent when a mention sits beside it", () => {
    // The marker disqualifies its own tag, not the tags around it.
    const reply = post(MIDDLE, [
      ["e", ROOT, "", "mention", "a".repeat(64)],
      ["e", LEAF],
    ]);
    expect(replyParent(reply)).toBe(LEAF);
  });
});

describe("isDirectReply", () => {
  it("accepts a NIP-10 reply to the post", () => {
    expect(
      isDirectReply(
        post(MIDDLE, [["e", ROOT, "", "reply", "a".repeat(64)]]),
        ROOT,
      ),
    ).toBe(true);
  });

  it("accepts a NIP-22 comment answering the post", () => {
    const comment = post(
      MIDDLE,
      [
        ["E", ROOT, "", "a".repeat(64)],
        ["K", "1"],
        ["P", "a".repeat(64)],
        ["e", ROOT, "", "a".repeat(64)],
        ["k", "1"],
        ["p", "a".repeat(64)],
      ],
      COMMENT_KIND,
    );
    expect(isDirectReply(comment, ROOT)).toBe(true);
  });

  it("rejects a reply that answers a deeper post, not this one", () => {
    // The thread root is named, but the reply answers the middle post. The
    // answer is named first so that position alone would name the root.
    const reply = post(LEAF, [
      ["e", MIDDLE, "", "reply", "a".repeat(64)],
      ["e", ROOT, "", "root", "a".repeat(64)],
    ]);
    expect(isDirectReply(reply, ROOT)).toBe(false);
    expect(isDirectReply(reply, MIDDLE)).toBe(true);
  });

  it("never counts a post as its own reply", () => {
    expect(isDirectReply(post(ROOT, [["e", ROOT, "", "reply", "x"]]), ROOT)).toBe(
      false,
    );
  });

  it("does not read a NIP-10 reply as a NIP-22 comment", () => {
    // A reply's `root` marker is lowercase e, not a NIP-22 scope tag. If it
    // were read as a comment parent, the whole thread would hang off the
    // top post instead of sitting under the post it answers.
    const reply = post(MIDDLE, [
      ["e", ROOT, "", "root", "x"],
      ["e", LEAF, "", "reply", "x"],
    ]);
    expect(commentReplyParent(reply)).toBeNull();
  });

  it("leaves a NIP-22 comment scoped to an address without a parent", () => {
    // An `A` scope names an address, so no event answers this comment and the
    // lower-case scope tag names one too. There is no `e` here: an address has
    // no event to answer.
    const comment = post(
      MIDDLE,
      [
        ["A", "30023:3c98:slug"],
        ["K", "30023"],
        ["a", "30023:3c98:slug"],
        ["k", "30023"],
      ],
      COMMENT_KIND,
    );
    expect(isDirectReply(comment, ROOT)).toBe(false);
  });

  it("does not read a NIP-22 comment's own e tag as its parent without a scope", () => {
    // A kind 1111 comment carrying only a lowercase `e` is the legacy form, not
    // a NIP-22 scope. The comment path must leave it alone, or the uppercase
    // scope guard it exists to enforce is dead: accepting any `e` here is what
    // reads a reply's own `root` marker as a parent and hangs a whole thread off
    // the top post.
    const legacy = post(MIDDLE, [["e", ROOT]], COMMENT_KIND);
    expect(commentReplyParent(legacy)).toBeNull();
    // The NIP-10 path still finds it, so the thread link is not lost.
    expect(isDirectReply(legacy, ROOT)).toBe(true);
  });

  it("ignores posts that are neither kind 1 nor NIP-22", () => {
    // A repost points at a post with an e tag but is not an answer to it.
    const repost = post(MIDDLE, [["e", ROOT]], 6);
    expect(isDirectReply(repost, ROOT)).toBe(false);
  });

  it("does not list a post that only mentions the one as an answer", () => {
    // The thread is read off this answer, so a `mention` marker reaching it
    // would put the referring post into someone else's conversation.
    const quoting = post(MIDDLE, [["e", ROOT, "", "mention", "x"]]);
    expect(isDirectReply(quoting, ROOT)).toBe(false);
    expect(directReplies([quoting], ROOT)).toEqual([]);
  });
});

describe("directReplies", () => {
  const toRoot = post("4".repeat(64), [["e", ROOT, "", "reply", "x"]], 1, 300);
  const older = post("5".repeat(64), [["e", ROOT, "", "reply", "x"]], 1, 100);
  const newer = post("6".repeat(64), [["e", ROOT, "", "reply", "x"]], 1, 200);
  const deeper = post("7".repeat(64), [
    ["e", ROOT, "", "root", "x"],
    ["e", MIDDLE, "", "reply", "x"],
  ], 1, 150);

  it("keeps only the direct answers, oldest first", () => {
    const result = directReplies([newer, deeper, toRoot, older], ROOT);
    expect(result.map((e) => e.id)).toEqual([older.id, newer.id, toRoot.id]);
  });

  it("returns nothing when the post has no answers", () => {
    expect(directReplies([post("8".repeat(64))], ROOT)).toEqual([]);
  });

  it("orders a comment among the replies by time, not by kind", () => {
    const comment = post(
      "9".repeat(64),
      [
        ["E", ROOT, "", "x"],
        ["K", "1"],
        ["e", ROOT, "", "x"],
        ["k", "1"],
      ],
      COMMENT_KIND,
      150,
    );
    const result = directReplies([older, comment, newer], ROOT);
    expect(result.map((e) => e.id)).toEqual([older.id, comment.id, newer.id]);
  });
});
