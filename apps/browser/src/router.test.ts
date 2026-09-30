import { describe, expect, it } from "vitest";
import { parseHash, profileHash, toHash } from "./router.js";

describe("parseHash", () => {
  it("parses menu routes", () => {
    expect(parseHash("#/home")).toEqual({ name: "menu", menu: "home" });
    expect(parseHash("#/network")).toEqual({ name: "menu", menu: "network" });
    expect(parseHash("#/settings/")).toEqual({
      name: "menu",
      menu: "settings",
    });
  });

  it("parses profile routes with and without a pubkey", () => {
    expect(parseHash("#/profile")).toEqual({
      name: "profile",
      pubkey: null,
      invalid: false,
    });
    expect(parseHash("#/profile/")).toEqual({
      name: "profile",
      pubkey: null,
      invalid: false,
    });
    expect(parseHash(`#/profile/${"A".repeat(64)}`)).toEqual({
      name: "profile",
      pubkey: "a".repeat(64),
      invalid: false,
    });
  });

  it("flags a broken profile link instead of showing the home feed", () => {
    // Falling back to home here would quietly show someone else's feed.
    expect(parseHash("#/profile/short")).toEqual({
      name: "profile",
      pubkey: null,
      invalid: true,
    });
    expect(parseHash(`#/profile/${"a".repeat(65)}`)).toEqual({
      name: "profile",
      pubkey: null,
      invalid: true,
    });
    expect(parseHash("#/profile/zz")).toEqual({
      name: "profile",
      pubkey: null,
      invalid: true,
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

  it("parses event routes case-insensitively", () => {
    const id = "A".repeat(64);
    expect(parseHash(`#/event/${id}`)).toEqual({
      name: "event",
      eventId: "a".repeat(64),
    });
  });

  it("falls back to home for empty or unknown hashes", () => {
    expect(parseHash("")).toEqual({ name: "menu", menu: "home" });
    expect(parseHash("#/")).toEqual({ name: "menu", menu: "home" });
    expect(parseHash("#/nope")).toEqual({ name: "menu", menu: "home" });
    expect(parseHash("#/event/short")).toEqual({
      name: "menu",
      menu: "home",
    });
  });
});
