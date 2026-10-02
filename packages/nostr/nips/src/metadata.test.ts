import { describe, expect, it } from "vitest";
import { computeEventId } from "./event.js";
import {
  birthdayFrom,
  birthdayTo,
  buildMetadata,
  METADATA_KIND,
  parseMetadata,
  withMetadata,
} from "./metadata.js";

const ME = "1".repeat(64);

function metadata(content: string, kind = METADATA_KIND): unknown {
  const base = {
    pubkey: ME,
    created_at: 1700000000,
    kind,
    tags: [],
    content,
  };
  return { ...base, id: computeEventId(base), sig: "c".repeat(128) };
}

describe("parseMetadata", () => {
  it("reads the fields the author published", () => {
    const event = metadata(
      JSON.stringify({ name: "alice", about: "hi", picture: "https://x/a.png" }),
    );
    expect(parseMetadata(event as never)).toEqual({
      name: "alice",
      about: "hi",
      picture: "https://x/a.png",
    });
  });

  it("keeps fields it does not know", () => {
    // A profile is free-form JSON. A client that knows six fields still has to
    // be able to republish the rest, or editing a name deletes the rest.
    const event = metadata(
      JSON.stringify({ name: "alice", lud16: "alice@wallet.example" }),
    );
    expect(parseMetadata(event as never)).toHaveProperty("lud16");
  });

  it("reads an unreadable profile as empty rather than failing", () => {
    expect(parseMetadata(metadata("not json") as never)).toEqual({});
    expect(parseMetadata(metadata("[1,2]") as never)).toEqual({});
    expect(parseMetadata(metadata("null") as never)).toEqual({});
    expect(parseMetadata(metadata("{}", 1) as never)).toEqual({});
    expect(parseMetadata(null)).toEqual({});
  });
});

describe("withMetadata", () => {
  const existing = {
    name: "alice",
    about: "old bio",
    lud16: "alice@wallet.example",
  };

  it("changes only what it was given", () => {
    expect(withMetadata(existing, { about: "new bio" })).toEqual({
      name: "alice",
      about: "new bio",
      lud16: "alice@wallet.example",
    });
  });

  it("removes a field cleared to an empty string", () => {
    // NIP-01 cannot say "present but empty", so clearing means removing.
    expect(withMetadata(existing, { about: "" })).not.toHaveProperty("about");
  });

  it("removes a field set to null", () => {
    expect(withMetadata(existing, { about: null })).not.toHaveProperty("about");
  });

  it("trims what it writes, so a stray space is not published", () => {
    expect(withMetadata(existing, { about: "  new bio  " })).toHaveProperty(
      "about",
      "new bio",
    );
  });

  it("never changes the profile it was given", () => {
    withMetadata(existing, { about: "new bio", about2: "x" });
    expect(existing.about).toBe("old bio");
  });

  it("keeps a boolean false, which is an answer and not an emptiness", () => {
    // NIP-24's `bot` is false when the account is not a bot. Dropping it for
    // being falsy would publish an account nobody can mark as a bot at all.
    expect(withMetadata({ bot: true }, { bot: false })).toEqual({ bot: false });
  });

  it("keeps an object field as it is", () => {
    // NIP-24's `birthday` is an object, not text.
    expect(
      withMetadata({ bot: true }, { birthday: { year: 1990, month: 2, day: 3 } }),
    ).toEqual({ bot: true, birthday: { year: 1990, month: 2, day: 3 } });
  });

  it("keeps a number field, zero included", () => {
    expect(withMetadata({}, { weight: 0 })).toEqual({ weight: 0 });
  });

  it("removes an empty object, which says less than no field at all", () => {
    // `false` is a real answer and stays, but `{}` is not an answer to anything:
    // no client reads a field out of it, so publishing it is noise in a profile
    // other people see in full.
    expect(withMetadata({}, { birthday: {} })).toEqual({});
    expect(withMetadata({ birthday: { year: 1990 } }, { birthday: {} })).toEqual({});
    // An object with anything in it is a value, not an absence.
    expect(
      withMetadata({}, { birthday: { year: 1990 } }),
    ).toEqual({ birthday: { year: 1990 } });
  });
});

describe("NIP-24's birthday", () => {
  it("reads a date as the object the NIP names", () => {
    expect(birthdayFrom("1990-02-03")).toEqual({
      year: 1990,
      month: 2,
      day: 3,
    });
  });

  it("will not invent the year a partial date leaves out", () => {
    // The name of this used to claim the opposite — that a partial date reads as
    // the fields it has — while the assertion underneath said it reads as null.
    // Null is right: a date input cannot hold a partial date, and guessing a year
    // would publish a birth year the reader never gave.
    expect(birthdayFrom("1990")).toBeNull();
    expect(birthdayFrom("02-03")).toBeNull();
    expect(birthdayFrom("--02-03")).toBeNull();
  });

  it("refuses a date nobody could have been born on", () => {
    expect(birthdayFrom("1990-13-01")).toBeNull();
    expect(birthdayFrom("1990-01-32")).toBeNull();
    expect(birthdayFrom("")).toBeNull();
    expect(birthdayFrom("not a date")).toBeNull();
    // Inside 1..12 and 1..31, and still not a date. The range checks were the
    // whole of what was checked, so each of these was published as a birthday:
    // a date no client can render, written by the reader and read by everyone.
    expect(birthdayFrom("1990-02-31")).toBeNull();
    expect(birthdayFrom("1990-04-31")).toBeNull();
    expect(birthdayFrom("1990-06-31")).toBeNull();
    expect(birthdayFrom("1990-09-31")).toBeNull();
    expect(birthdayFrom("1990-11-31")).toBeNull();
    // February, which is 29 days only in a leap year — and not every year
    // divisible by four is one.
    expect(birthdayFrom("1990-02-29")).toBeNull();
    expect(birthdayFrom("1900-02-29")).toBeNull();
    expect(birthdayFrom("1992-02-29")).toEqual({ year: 1992, month: 2, day: 29 });
    expect(birthdayFrom("2000-02-29")).toEqual({ year: 2000, month: 2, day: 29 });
    // And the 31-day months keep their 31st.
    expect(birthdayFrom("1990-01-31")).toEqual({ year: 1990, month: 1, day: 31 });
    expect(birthdayFrom("1990-12-31")).toEqual({ year: 1990, month: 12, day: 31 });
    expect(birthdayFrom("1990-04-30")).toEqual({ year: 1990, month: 4, day: 30 });
  });

  it("writes the object back as a date a form can hold", () => {
    expect(birthdayTo({ year: 1990, month: 2, day: 3 })).toBe("1990-02-03");
    // A birthday with no year is not a date, so it reads as empty rather than
    // as a wrong one.
    expect(birthdayTo({ month: 2, day: 3 })).toBe("");
    expect(birthdayTo(undefined)).toBe("");
    expect(birthdayTo("1990-02-03")).toBe("");
  });

  it("refuses to build a date out of parts that are not there", () => {
    // Padding whatever was found gave `"2024--20"` for a month written as a
    // string — a malformed date, which a date input answers by showing nothing.
    // A profile with a birthday then read as one without, in the one field whose
    // whole job is to say whether the reader published a birthday.
    expect(birthdayTo({ year: 2024, month: "7", day: 20 })).toBe("");
    expect(birthdayTo({ year: "2024", month: 7, day: 20 })).toBe("");
    expect(birthdayTo({ year: 2024, month: 7 })).toBe("");
    expect(birthdayTo({ year: 2024, month: 7, day: null })).toBe("");
    // A short year is padded rather than dropped: the profile says 20, so
    // `0020-05-06` is what it says, and answering empty would report a profile
    // that has a birthday as one that has none.
    expect(birthdayTo({ year: 20, month: 5, day: 6 })).toBe("0020-05-06");
    // Beyond what a date input holds, and dates it cannot hold.
    expect(birthdayTo({ year: 10000, month: 5, day: 6 })).toBe("");
    expect(birthdayTo({ year: 2024, month: 13, day: 1 })).toBe("");
    expect(birthdayTo({ year: 2024, month: 0, day: 1 })).toBe("");
    expect(birthdayTo({ year: 2024, month: 2, day: 31 })).toBe("");
    expect(birthdayTo({ year: 2023, month: 2, day: 29 })).toBe("");
    // A fraction is not a birthday, and `2.5` would pad to `2.5`.
    expect(birthdayTo({ year: 2024.5, month: 2, day: 3 })).toBe("");
    expect(birthdayTo({ year: 2024, month: 2.5, day: 3 })).toBe("");
    // And a leap day is a date, so it survives.
    expect(birthdayTo({ year: 2024, month: 2, day: 29 })).toBe("2024-02-29");
  });
});

describe("buildMetadata", () => {
  it("publishes the replaceable kind 0 the profile lives in", () => {
    const sent = buildMetadata({
      pubkey: ME,
      metadata: { name: "alice", about: "hi" },
      createdAt: 1700000000,
    });
    expect(sent.kind).toBe(METADATA_KIND);
    expect(sent.pubkey).toBe(ME);
    expect(sent.tags).toEqual([]);
    expect(JSON.parse(sent.content)).toEqual({ about: "hi", name: "alice" });
  });

  it("writes the keys in one order, so the same profile is the same event", () => {
    const a = buildMetadata({
      pubkey: ME,
      metadata: { name: "alice", about: "hi", website: "https://x" },
      createdAt: 1,
    });
    const b = buildMetadata({
      pubkey: ME,
      metadata: { website: "https://x", about: "hi", name: "alice" },
      createdAt: 1,
    });
    expect(a.content).toBe(b.content);
    expect(Object.keys(JSON.parse(a.content))).toEqual(["about", "name", "website"]);
  });

  it("carries fields the app does not edit", () => {
    const sent = buildMetadata({
      pubkey: ME,
      metadata: withMetadata({ lud16: "a@b.example" }, { name: "alice" }),
      createdAt: 1,
    });
    expect(JSON.parse(sent.content)).toEqual({
      lud16: "a@b.example",
      name: "alice",
    });
  });

  it("publishes an empty profile as an empty object, not nothing", () => {
    const sent = buildMetadata({ pubkey: ME, metadata: {}, createdAt: 1 });
    expect(sent.content).toBe("{}");
  });
});