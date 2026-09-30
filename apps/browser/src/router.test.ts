import { describe, expect, it } from "vitest";
import { parseHash } from "./router.js";

describe("parseHash", () => {
  it("parses menu routes", () => {
    expect(parseHash("#/home")).toEqual({ name: "menu", menu: "home" });
    expect(parseHash("#/network")).toEqual({ name: "menu", menu: "network" });
    expect(parseHash("#/settings/")).toEqual({
      name: "menu",
      menu: "settings",
    });
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
