import { describe, expect, it } from "vitest";
import { computeEventId, type NostrEvent } from "./event.js";
import {
  buildQuoteRepost,
  buildReaction,
  buildReply,
  buildRepost,
  mentionedPubkeys,
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

describe("event integrity", () => {
  it("produces an unsigned template with a stable id", () => {
    const event = buildReaction({ pubkey: ME, target, createdAt: AT });
    expect(computeEventId(event)).toBe(computeEventId({ ...event }));
    // Builders never sign; the signer adds the signature.
    expect("sig" in event).toBe(false);
  });
});
