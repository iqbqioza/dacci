import { describe, expect, it } from "vitest";
import {
  buildMuteList,
  MUTE_LIST_KIND,
  mutedIn,
  mutedPubkeys,
  muteTags,
  withMuted,
} from "./mute-list.js";

const ME = "1".repeat(64);
const ALICE = "2".repeat(64);
const BOB = "3".repeat(64);
const CAROL = "4".repeat(64);

function list(tags: string[][], kind = MUTE_LIST_KIND): unknown {
  return {
    id: "a".repeat(64),
    kind,
    pubkey: ME,
    created_at: 1700000000,
    content: "",
    tags,
    sig: "c".repeat(128),
  };
}

describe("muteTags", () => {
  it("keeps every tag, not only the p tags", () => {
    // NIP-51 lets a mute list also hold hashtags, words and threads. Adding one
    // person republishes the whole list, so dropping those would delete them.
    const event = list([
      ["p", ALICE],
      ["t", "spoiler"],
      ["word", "scam"],
      ["e", "e".repeat(64)],
    ]);
    expect(muteTags(event as never)).toEqual([
      ["p", ALICE],
      ["t", "spoiler"],
      ["word", "scam"],
      ["e", "e".repeat(64)],
    ]);
  });

  it("reads nothing from another kind", () => {
    expect(muteTags(list([["p", ALICE]], 3) as never)).toEqual([]);
    expect(muteTags(null)).toEqual([]);
  });
});

describe("mutedPubkeys", () => {
  it("collects the people, in order and without repeats", () => {
    const tags = [
      ["p", ALICE],
      ["t", "spoiler"],
      ["p", BOB],
      ["p", ALICE],
      ["p", "not-a-key"],
    ];
    expect(mutedPubkeys(tags)).toEqual([ALICE, BOB]);
  });
});

describe("mutedIn", () => {
  it("says whether the list holds someone", () => {
    expect(mutedIn([["p", ALICE]], ALICE)).toBe(true);
    expect(mutedIn([["p", ALICE]], BOB)).toBe(false);
    expect(mutedIn([], ALICE)).toBe(false);
  });
});

describe("withMuted", () => {
  it("appends a new name at the end, as NIP-51 asks", () => {
    const tags = [["p", ALICE], ["p", BOB]];
    expect(withMuted(tags, CAROL, true)).toEqual([
      ["p", ALICE],
      ["p", BOB],
      ["p", CAROL],
    ]);
  });

  it("keeps the hashtags and words of the list when a name is added", () => {
    const tags = [["p", ALICE], ["word", "scam"], ["t", "spoiler"]];
    expect(withMuted(tags, BOB, true)).toEqual([
      ["p", ALICE],
      ["word", "scam"],
      ["t", "spoiler"],
      ["p", BOB],
    ]);
  });

  it("leaves someone already muted exactly where they are", () => {
    const tags = [["p", ALICE], ["p", BOB]];
    expect(withMuted(tags, ALICE, true)).toBe(tags);
  });

  it("removes a name and nothing else", () => {
    const tags = [["p", ALICE], ["word", "scam"], ["p", BOB]];
    expect(withMuted(tags, ALICE, false)).toEqual([
      ["word", "scam"],
      ["p", BOB],
    ]);
  });

  it("refuses to mute what is not a pubkey, and still unmutes it", () => {
    // NIP-01 `p` values are 32-byte lowercase hex. Appending anything else
    // publishes a mute no other client honors while this one shows it as
    // done, so the write is refused and the list comes back untouched.
    const tags = [["p", ALICE]];
    expect(withMuted(tags, "not-hex", true)).toBe(tags);
    expect(withMuted(tags, "ABC", true)).toBe(tags);
    // Removing is exempt: a malformed entry already in the list is garbage no
    // client honors, and refusing to drop it would keep it there for good.
    const dirty: string[][] = [["p", ALICE], ["p", "not-hex"]];
    expect(withMuted(dirty, "not-hex", false)).toEqual([["p", ALICE]]);
  });

  it("drops every entry for someone unmuted, because twice still mutes", () => {
    const tags = [["p", ALICE], ["p", BOB], ["p", ALICE]];
    expect(withMuted(tags, ALICE, false)).toEqual([["p", BOB]]);
  });

  it("leaves an empty list empty when nobody is unmuted", () => {
    expect(withMuted([], ALICE, false)).toEqual([]);
  });
});

describe("buildMuteList", () => {
  it("publishes the replaceable kind 10000 the list lives in", () => {
    const sent = buildMuteList({
      pubkey: ME,
      tags: [["p", ALICE]],
      createdAt: 1700000000,
    });
    expect(sent.kind).toBe(MUTE_LIST_KIND);
    expect(sent.pubkey).toBe(ME);
    expect(sent.tags).toEqual([["p", ALICE]]);
    expect(sent.content).toBe("");
  });
});