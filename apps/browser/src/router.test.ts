import { describe, expect, it } from "vitest";
import { feedHash, parseHash, profileHash, toHash } from "./router.js";

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
