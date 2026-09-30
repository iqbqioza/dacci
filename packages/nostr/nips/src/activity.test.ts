import { describe, expect, it } from "vitest";
import { computeEventId, type NostrEvent } from "./event.js";
import {
  buildDeletion,
  commentParent,
  isComment,
  buildQuoteRepost,
  buildReaction,
  buildReply,
  buildRepost,
  mentionedPubkeys,
  summarizeMyActivity,
} from "./activity.js";

const ME = "1".repeat(64);
const AUTHOR = "2".repeat(64);
const ROOT_AUTHOR = "3".repeat(64);
const AT = 1_700_000_000;

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

/** A signed event whose id follows from its own content. */
function signed(
  kind: number,
  pubkey: string,
  tags: string[][],
  created_at: number,
): NostrEvent {
  const base = { pubkey, created_at, kind, tags, content: "" };
  return { ...base, id: computeEventId(base), sig: "s".repeat(128) };
}

const target = note("a".repeat(64), AUTHOR);
const root = note("b".repeat(64), ROOT_AUTHOR);

function tagValue(
  event: { tags: string[][] },
  name: string,
  marker?: string,
): string[] | undefined {
  return event.tags.find(
    (t) => t[0] === name && (marker === undefined || t[4] === marker),
  );
}

describe("buildReply", () => {
  it("marks a top-level target as both root and reply", () => {
    const event = buildReply({
      pubkey: ME,
      text: "こんにちは",
      target,
      createdAt: AT,
    });
    expect(event.kind).toBe(1);
    expect(event.content).toBe("こんにちは");
    expect(tagValue(event, "e", "root")?.[1]).toBe(target.id);
    expect(tagValue(event, "e", "reply")?.[1]).toBe(target.id);
    expect(tagValue(event, "p")?.[1]).toBe(AUTHOR);
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

  it("adds a NIP-27 mentions tag for the author named in the text", () => {
    const event = buildReply({
      pubkey: ME,
      text: `@${AUTHOR} さんへ`,
      target,
      createdAt: AT,
    });
    expect(tagValue(event, "mentions")?.slice(1)).toEqual([AUTHOR]);
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
  it("matches bare pubkeys and nostr: URIs only", () => {
    expect(mentionedPubkeys(`hi ${AUTHOR}`, [AUTHOR])).toEqual([AUTHOR]);
    expect(mentionedPubkeys(`nostr:${AUTHOR}`, [AUTHOR])).toEqual([AUTHOR]);
    expect(mentionedPubkeys("nothing here", [AUTHOR])).toEqual([]);
    expect(mentionedPubkeys(AUTHOR, ["short"])).toEqual([]);
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
    expect(isComment(buildComment(1, [["i", "30023", AUTHOR, "post"]]))).toBe(
      true,
    );
  });

  it("leaves ordinary notes and replies alone", () => {
    expect(isComment(buildComment(1, []))).toBe(false);
    expect(isComment(buildComment(1, [["e", "f".repeat(64)], ["p", AUTHOR]]))).toBe(
      false,
    );
  });
});

describe("commentParent", () => {
  it("reads the NIP-22 I tag of a comment", () => {
    const event = buildComment(1111, [
      ["I", "30023", AUTHOR, "my-article"],
      ["p", ME],
    ]);
    expect(commentParent(event)).toBe(`30023:${AUTHOR}:my-article`);
  });

  it("accepts the lowercase tag some clients still send", () => {
    const event = buildComment(1111, [["i", "1", AUTHOR, "d"]]);
    expect(commentParent(event)).toBe(`1:${AUTHOR}:d`);
  });

  it("falls back to the legacy e tag", () => {
    const event = buildComment(1111, [["e", "f".repeat(64)]]);
    expect(commentParent(event)).toBe("f".repeat(64));
  });

  it("returns null for a non-comment or a parentless comment", () => {
    expect(commentParent(buildComment(1, [["e", "f".repeat(64)]]))).toBeNull();
    expect(commentParent(buildComment(1111, []))).toBeNull();
  });

  it("finds the parent of a kind 1 comment too", () => {
    const event = buildComment(1, [["I", "30023", AUTHOR, "my-article"]]);
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
    ["e", targetId, "", AUTHOR, "root"],
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

describe("event integrity", () => {
  it("produces an unsigned template with a stable id", () => {
    const event = buildReaction({ pubkey: ME, target, createdAt: AT });
    expect(computeEventId(event)).toBe(computeEventId({ ...event }));
    // Builders never sign; the signer adds the signature.
    expect("sig" in event).toBe(false);
  });
});
