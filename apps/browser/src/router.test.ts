import { bech32Encode } from "dacci-nostr-nips";
import { encodeNote, encodeNpub } from "dacci-nostr-nips";
import { describe, expect, it } from "vitest";
import { feedHash, parseHash, profileHash, toHash } from "./router.js";

/** Hex as the bytes NIP-19 writes into a TLV. */
function hexBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/** An `naddr`: TLV 0 the `d` tag, 2 the author, 3 the kind. */
function encodeNaddrFixture(identifier: string, pubkey: string, kind: number): string {
  const parts: number[] = [];
  const push = (type: number, value: number[]): void => {
    parts.push(type, value.length, ...value);
  };
  const kindBytes = [
    (kind >>> 24) & 0xff,
    (kind >>> 16) & 0xff,
    (kind >>> 8) & 0xff,
    kind & 0xff,
  ];
  push(0, [...new TextEncoder().encode(identifier)]);
  push(2, hexBytes(pubkey));
  push(3, kindBytes);
  return bech32Encode("naddr", new Uint8Array(parts));
}

describe("parseHash", () => {
  it("parses menu routes", () => {
    expect(parseHash("#/home")).toEqual({
      name: "menu",
      menu: "home",
      replies: false,
    });
    expect(parseHash("#/network")).toEqual({
      name: "menu",
      menu: "network",
      replies: false,
    });
    expect(parseHash("#/settings/")).toEqual({
      name: "menu",
      menu: "settings",
      replies: false,
    });
  });

  it("parses profile routes with and without a pubkey", () => {
    expect(parseHash("#/profile")).toEqual({
      name: "profile",
      pubkey: null,
      invalid: false,
      replies: false,
    });
    expect(parseHash("#/profile/")).toEqual({
      name: "profile",
      pubkey: null,
      invalid: false,
      replies: false,
    });
    expect(parseHash(`#/profile/${"A".repeat(64)}`)).toEqual({
      name: "profile",
      pubkey: "a".repeat(64),
      invalid: false,
      replies: false,
    });
  });

  it("reads a NIP-19 entity, which is the form every nostr client shares", () => {
    // A link a reader was given is an entity, not hex: `npub1…` is what every
    // other client writes in a profile link and `note1…` / `nevent1…` in a post
    // link. Only hex was read, so those were answered with "このリンクは壊れて
    // います" and the reader landed on their own profile instead of the person
    // the name belonged to.
    const key = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
    const noteId = "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";
    const npub = encodeNpub(key) as string;
    const note = encodeNote(noteId) as string;
    expect(parseHash(`#/profile/${npub}`)).toEqual({
      name: "profile",
      pubkey: key,
      invalid: false,
      replies: false,
    });
    // An `nprofile` names the same person and carries relay hints, which are
    // not used: the reader's own relays are asked, as everywhere else.
    const nprofile = bech32Encode("nprofile", new Uint8Array([0, 32, ...hexBytes(key)]));
    expect(parseHash(`#/profile/${nprofile}`)).toEqual({
      name: "profile",
      pubkey: key,
      invalid: false,
      replies: false,
    });
    expect(parseHash(`#/profile/${npub}/replies`)).toEqual({
      name: "profile",
      pubkey: key,
      invalid: false,
      replies: true,
    });
    expect(parseHash(`#/event/${note}`)).toEqual({
      name: "event",
      eventId: noteId,
    });
    // Percent-encoded, because a link copied out of a page arrives that way.
    expect(parseHash(`#/profile/${encodeURIComponent(npub)}`)).toEqual({
      name: "profile",
      pubkey: key,
      invalid: false,
      replies: false,
    });
    expect(parseHash(`#/event/${encodeURIComponent(note)}`)).toEqual({
      name: "event",
      eventId: noteId,
    });
  });

  it("still refuses a link that names nobody", () => {
    // The entity has to be one: a checksum failure means the word merely looks
    // like a pubkey, and reading it as a person would show a timeline that does
    // not exist.
    const key = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
    expect(parseHash("#/profile/npub1notarealkeyatall")).toEqual({
      name: "profile",
      pubkey: null,
      invalid: true,
      replies: false,
    });
    // A post link that names nothing falls through to the home feed, as any
    // unknown hash does.
    expect(parseHash("#/event/note1notarealnoteid").name).toBe("menu");
    // And an `naddr` is a long-form article, not a person: no route here shows
    // one, so it stays broken rather than being read as somebody's profile.
    expect(parseHash(`#/profile/${encodeNaddrFixture("x", key, 30023)}`)).toEqual({
      name: "profile",
      pubkey: null,
      invalid: true,
      replies: false,
    });
  });

  it("reads a trailing /replies as the Replies and notes tab", () => {
    expect(parseHash("#/home/replies")).toEqual({
      name: "menu",
      menu: "home",
      replies: true,
    });
    expect(parseHash("#/profile/replies")).toEqual({
      name: "profile",
      pubkey: null,
      invalid: false,
      replies: true,
    });
    expect(parseHash(`#/profile/${"b".repeat(64)}/replies`)).toEqual({
      name: "profile",
      pubkey: "b".repeat(64),
      invalid: false,
      replies: true,
    });
  });

  it("keeps the tab the address bar names, however odd the path", () => {
    // The timeline reads the URL as the source of truth for the tab. A path
    // that strips down to a tab but does not match a page must not silently
    // switch it: the address bar would say `replies` while the list showed
    // Notes, and a copied link would carry the disagreement onward.
    expect(parseHash("#/home/replies/replies")).toEqual({
      name: "menu",
      menu: "home",
      replies: true,
    });
    expect(parseHash("#/notifications/replies/replies")).toEqual({
      name: "menu",
      menu: "notifications",
      replies: true,
    });
  });

  it("never reads the suffix as a menu or a pubkey", () => {
    // Without this, #/replies would open a page nobody can navigate back
    // from, and #/profile/replies would look like a broken pubkey.
    expect(parseHash("#/replies")).toEqual({
      name: "menu",
      menu: "home",
      replies: false,
    });
    expect(parseHash("#/notifications/replies")).toEqual({
      name: "menu",
      menu: "notifications",
      replies: true,
    });
  });

  it("keeps a broken profile link broken, with or without the suffix", () => {
    // The suffix must not rescue an unusable pubkey into a valid route.
    expect(parseHash("#/profile/short")).toEqual({
      name: "profile",
      pubkey: null,
      invalid: true,
      replies: false,
    });
    expect(parseHash("#/profile/short/replies")).toEqual({
      name: "profile",
      pubkey: null,
      invalid: true,
      replies: true,
    });
  });

  it("flags a broken profile link instead of showing the home feed", () => {
    // Falling back to home here would quietly show someone else's feed.
    expect(parseHash(`#/profile/${"a".repeat(65)}`)).toEqual({
      name: "profile",
      pubkey: null,
      invalid: true,
      replies: false,
    });
    expect(parseHash("#/profile/zz")).toEqual({
      name: "profile",
      pubkey: null,
      invalid: true,
      replies: false,
    });
  });

  it("builds profile links", () => {
    expect(profileHash("b".repeat(64))).toBe(`#/profile/${"b".repeat(64)}`);
  });

  it("never writes a doubled hash", () => {
    // A leading # is already there; adding another breaks every route.
    expect(toHash("#/home")).toBe("#/home");
    expect(toHash("/home")).toBe("#/home");
    expect(profileHash("c".repeat(64)).startsWith("#/")).toBe(true);
  });

  it("builds feed links, suffix only for the replies tab", () => {
    expect(feedHash("#/home", false)).toBe("#/home");
    expect(feedHash("#/home", true)).toBe("#/home/replies");
    // A trailing slash must not produce #/home//replies.
    expect(feedHash("#/home/", true)).toBe("#/home/replies");
    expect(feedHash("/home", true)).toBe("#/home/replies");
  });

  it("round-trips a feed link through the parser", () => {
    for (const base of ["#/home", "#/profile", `#/profile/${"d".repeat(64)}`]) {
      expect(parseHash(feedHash(base, true))).toMatchObject({ replies: true });
      expect(parseHash(feedHash(base, false))).toMatchObject({ replies: false });
    }
  });

  it("parses event routes case-insensitively", () => {
    const id = "A".repeat(64);
    expect(parseHash(`#/event/${id}`)).toEqual({
      name: "event",
      eventId: "a".repeat(64),
    });
  });

  it("falls back to home for empty or unknown hashes", () => {
    expect(parseHash("")).toEqual({
      name: "menu",
      menu: "home",
      replies: false,
    });
    expect(parseHash("#/")).toEqual({
      name: "menu",
      menu: "home",
      replies: false,
    });
    expect(parseHash("#/nope")).toEqual({
      name: "menu",
      menu: "home",
      replies: false,
    });
    expect(parseHash("#/event/short")).toEqual({
      name: "menu",
      menu: "home",
      replies: false,
    });
  });
});
