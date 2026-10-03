import { describe, expect, it } from "vitest";
import { computeEventId } from "./event.js";
import {
  buildFollowList,
  CONTACTS_KIND,
  contactPubkeys,
  contactTags,
  followsIn,
  parseContacts,
  withFollowed,
} from "./contacts.js";

const ALICE = "b".repeat(64);
const BOB = "c".repeat(64);
const CAROL = "d".repeat(64);

function makeContactsEvent(tags: string[][]) {
  const base = {
    pubkey: "a".repeat(64),
    created_at: 100,
    kind: CONTACTS_KIND,
    tags,
    content: "",
  };
  return { ...base, id: computeEventId(base), sig: "b".repeat(128) };
}

describe("parseContacts", () => {
  it("collects valid p tags and dedupes", () => {
    const event = makeContactsEvent([
      ["p", "b".repeat(64)],
      ["p", "c".repeat(64)],
      ["p", "b".repeat(64)],
      ["p", "not-hex"],
      ["e", "d".repeat(64)],
    ]);
    expect(parseContacts(event)).toEqual(["b".repeat(64), "c".repeat(64)]);
  });

  it("returns empty for other kinds", () => {
    const event = { ...makeContactsEvent([]), kind: 1 };
    expect(parseContacts(event)).toEqual([]);
  });

  it("returns empty for no event at all", () => {
    expect(parseContacts(null as never)).toEqual([]);
  });
});

describe("contactTags", () => {
  it("keeps the whole tag, so a relay hint and a petname survive", () => {
    // NIP-02 lets a p tag carry a relay and a petname after the key. Republish
    // the list and those have to come back with it, or following one more
    // person silently strips them from everyone else.
    const event = makeContactsEvent([
      ["p", ALICE, "wss://relay.example", "alice"],
      ["p", BOB],
    ]);
    expect(contactTags(event)).toEqual([
      ["p", ALICE, "wss://relay.example", "alice"],
      ["p", BOB],
    ]);
  });

  it("leaves out anything that is not a p tag naming a pubkey", () => {
    expect(
      contactTags(
        makeContactsEvent([["e", ALICE], ["p", "short"], ["p"], ["p", ALICE]]),
      ),
    ).toEqual([["p", ALICE]]);
  });
});

describe("followsIn", () => {
  it("says whether a list names someone", () => {
    const tags = contactTags(makeContactsEvent([["p", ALICE]]));
    expect(followsIn(tags, ALICE)).toBe(true);
    expect(followsIn(tags, BOB)).toBe(false);
  });

  it("agrees with the enumerator and the writer about a name that is not a key", () => {
    // A `p` value that is not 32-byte lowercase hex names nobody: `contactTags`
    // and `contactPubkeys` drop it and `withFollowed` refuses to write one. Read
    // without the same gate it said *followed* here and *not in the list*
    // everywhere else, so the button offered to follow someone again who was
    // already followed.
    const tags = contactTags(makeContactsEvent([["p", "alice"]]));
    expect(tags).toEqual([]);
    expect(followsIn([["p", "alice"]], "alice")).toBe(false);
    expect(withFollowed([], "alice", true)).toEqual([]);
    // And a real key is still found.
    expect(followsIn([["p", ALICE]], ALICE)).toBe(true);
  });
});

describe("withFollowed", () => {
  it("adds someone at the end, leaving everyone else in place", () => {
    const tags = contactTags(makeContactsEvent([["p", ALICE], ["p", BOB]]));
    expect(withFollowed(tags, CAROL, true)).toEqual([
      ["p", ALICE],
      ["p", BOB],
      ["p", CAROL],
    ]);
  });

  it("removes someone without touching the rest", () => {
    const tags = contactTags(makeContactsEvent([["p", ALICE], ["p", BOB]]));
    expect(withFollowed(tags, ALICE, false)).toEqual([["p", BOB]]);
  });

  it("refuses to follow what is not a pubkey, and still unfollows it", () => {
    const tags = contactTags(makeContactsEvent([["p", ALICE]]));
    expect(withFollowed(tags, "not-hex", true)).toBe(tags);
    const dirty: string[][] = [["p", ALICE], ["p", "not-hex"]];
    expect(withFollowed(dirty, "not-hex", false)).toEqual([["p", ALICE]]);
  });

  it("keeps the relay hint of the person who is already followed", () => {
    const tags = contactTags(
      makeContactsEvent([["p", ALICE, "wss://relay.example", "alice"]]),
    );
    expect(withFollowed(tags, ALICE, true)).toEqual([
      ["p", ALICE, "wss://relay.example", "alice"],
    ]);
  });

  it("keeps the order of the list when one more name is added", () => {
    const tags = contactTags(
      makeContactsEvent([["p", ALICE], ["p", BOB], ["p", CAROL]]),
    );
    expect(contactPubkeys(withFollowed(tags, "e".repeat(64), true))).toEqual([
      ALICE,
      BOB,
      CAROL,
      "e".repeat(64),
    ]);
  });

  it("drops every entry for someone unfollowed, because naming twice still follows", () => {
    const tags = contactTags(makeContactsEvent([["p", ALICE], ["p", BOB], ["p", ALICE]]));
    expect(withFollowed(tags, ALICE, false)).toEqual([["p", BOB]]);
  });

  it("leaves an empty list empty when nobody is unfollowed", () => {
    expect(withFollowed([], ALICE, false)).toEqual([]);
  });
});

describe("buildFollowList", () => {
  it("builds the replaceable kind 3 the list is published as", () => {
    const sent = buildFollowList({
      pubkey: "a".repeat(64),
      tags: [["p", ALICE]],
      createdAt: 1700000000,
    });
    expect(sent.kind).toBe(CONTACTS_KIND);
    expect(sent.tags).toEqual([["p", ALICE]]);
    expect(sent.content).toBe("");
  });
});