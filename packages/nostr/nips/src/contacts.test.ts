import { describe, expect, it } from "vitest";
import { computeEventId } from "./event.js";
import { CONTACTS_KIND, parseContacts } from "./contacts.js";

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
});
