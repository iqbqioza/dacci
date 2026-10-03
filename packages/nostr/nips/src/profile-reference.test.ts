import { describe, expect, it } from "vitest";
import { bech32Encode } from "./bech32.js";
import {
  contentSegments,
  encodeNpub,
  mentionedProfiles,
  profileReferences,
  textSegments,
  type ContentSegment,
  type NostrEvent,
} from "./index.js";

const ALICE = "5f6dc275f3f9f8752d010a110c226148a9ba3399c5b63a0f469ee93b1394a53e";
const BOB = "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
const NOUNCE = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";

const npub = (pubkey: string): string => `nostr:${encodeNpub(pubkey)}`;

/** The `nprofile` spelling NIP-27 asks writers to use for a mention. */
const nprofile = (pubkey: string): string => {
  const bytes: number[] = [];
  for (let i = 0; i < pubkey.length; i += 2) {
    bytes.push(parseInt(pubkey.slice(i, i + 2), 16));
  }
  return `nostr:${bech32Encode("nprofile", new Uint8Array([0, 32, ...bytes]))}`;
};
const names: Record<string, string> = { [ALICE]: "Alice", [BOB]: "Bob" };
const nameOf = (pubkey: string): string => names[pubkey] ?? pubkey.slice(0, 8);

function note(content: string, tags: string[][] = []): NostrEvent {
  return {
    id: "a".repeat(64),
    pubkey: NOUNCE,
    created_at: 1700000000,
    kind: 1,
    tags,
    content,
    sig: "c".repeat(128),
  };
}

describe("profileReferences", () => {
  it("finds the profile a post names", () => {
    const found = profileReferences(`hi ${npub(ALICE)}`);
    expect(found).toHaveLength(1);
    expect(found[0].pubkey).toBe(ALICE);
  });

  it("reports where the reference sits, so the text around it can be kept", () => {
    const text = `hi ${npub(ALICE)}`;
    const [found] = profileReferences(text);
    expect(text.slice(found.start, found.end)).toBe(npub(ALICE));
  });

  it("reads the nprofile spelling NIP-27 asks writers to use", () => {
    // Without this the mention renders as raw bech32, which is what a reader
    // following NIP-27 wrote and cannot read.
    const found = profileReferences(`hi ${nprofile(ALICE)}`);
    expect(found).toHaveLength(1);
    expect(found[0].pubkey).toBe(ALICE);
  });

  it("shows an nprofile mention by name, like any other", () => {
    const segments = textSegments(`hi ${nprofile(ALICE)}!`, nameOf);
    const mention = segments.find((s) => s.kind === "mention");
    expect(mention?.kind === "mention" && mention.mention.label).toBe("Alice");
  });

  it("counts both spellings of the same person once", () => {
    expect(mentionedProfiles(`${nprofile(ALICE)} ${npub(ALICE)}`)).toEqual([ALICE]);
  });

  it("finds both spellings in one post, in reading order", () => {
    const found = profileReferences(`${npub(ALICE)} and ${nprofile(BOB)}`);
    expect(found.map((f) => f.pubkey)).toEqual([ALICE, BOB]);
  });

  it("leaves a word that only looks like one", () => {
    // The checksum decides, so prose beginning "npub1" is still prose.
    expect(profileReferences("npub1notarealkeyatall")).toEqual([]);
    expect(profileReferences("see nostr:npub1broken")).toEqual([]);
  });

  it("does not take an npub without its prefix as a reference", () => {
    // NIP-19 writes the entity behind `nostr:`, and a bare string is a
    // mention in some other convention that this is not guessing at.
    expect(profileReferences(encodeNpub(ALICE) as string)).toEqual([]);
  });

  it("leaves an entity that is part of a web address alone", () => {
    // `https://x.example/?u=nostr:npub1…` is a link to somewhere, and drawing the
    // uri out of it split the address in two and left the reader with
    // `https://x.example/?u= ` — a link that goes nowhere — next to a chip
    // claiming someone had been written about.
    for (const url of [
      `https://x.example/?u=${npub(ALICE)}`,
      `https://nostr.band/p/${encodeNpub(ALICE) as string}`,
      `https://x.example/#${nprofile(BOB)}`,
    ]) {
      expect(profileReferences(url), url).toEqual([]);
      expect(mentionedProfiles(url), url).toEqual([]);
    }
    // A profile's own bio is where a bare entity is otherwise a mention, and a
    // bare entity *inside a link there* is still part of the link.
    const bio = `my page https://nostr.band/p/${encodeNpub(ALICE) as string}`;
    expect(mentionedProfiles(bio, true)).toEqual([]);
    expect(mentionedProfiles(bio, false)).toEqual([]);
    // The person is still named when they are written outside any address.
    expect(mentionedProfiles(`ping ${npub(ALICE)}`, true)).toEqual([ALICE]);
  });

  it("finds several in reading order", () => {
    const found = profileReferences(`${npub(ALICE)} and ${npub(BOB)}`);
    expect(found.map((f) => f.pubkey)).toEqual([ALICE, BOB]);
  });

  it("lists each profile once, whatever the order", () => {
    expect(mentionedProfiles(`${npub(ALICE)} ${npub(BOB)} ${npub(ALICE)}`)).toEqual([
      ALICE,
      BOB,
    ]);
  });

  it("takes a bare npub as a reference only when the caller asks", () => {
    // A profile's bio is the one place a person writes their key out to mean
    // themselves. In a post a bare npub is as likely to be a key pasted for
    // looking up as it is a person being written about.
    const bare = encodeNpub(ALICE) as string;
    expect(profileReferences(`me: ${bare}`)).toEqual([]);
    expect(profileReferences(`me: ${bare}`, true)).toEqual([
      { pubkey: ALICE, start: 4, end: 4 + bare.length },
    ]);
  });

  it("still reads a prefixed npub when bare ones are allowed", () => {
    expect(profileReferences(`hi ${npub(ALICE)}`, true).map((f) => f.pubkey)).toEqual([
      ALICE,
    ]);
  });

  it("does not let a bare npub be read twice as two references", () => {
    // `nostr:npub1…` also matches from the `npub1` on, so the span has to be
    // consumed as a whole rather than restarted inside it.
    const found = profileReferences(npub(ALICE), true);
    expect(found).toHaveLength(1);
    expect(found[0].start).toBe(0);
    expect(found[0].end).toBe(npub(ALICE).length);
  });

  it("lists a bare npub once, with the rest of the text kept", () => {
    const bare = encodeNpub(ALICE) as string;
    expect(mentionedProfiles(`me ${bare} and ${npub(BOB)}`, true)).toEqual([
      ALICE,
      BOB,
    ]);
  });
});

describe("textSegments", () => {
  /** The text as a reader reads it: names in place, spacing joined up. */
  function read(segments: ContentSegment[]): string {
    return segments
      .map((segment) => {
        if (segment.kind === "text") return segment.text;
        if (segment.kind === "mention") return segment.mention.label;
        return "[image]";
      })
      .join("");
  }

  it("puts a space on each side in the middle of a sentence", () => {
    expect(read(textSegments(`hello ${npub(ALICE)} there`, nameOf))).toBe(
      "hello Alice there",
    );
  });

  it("puts a space only after it at the start of a line", () => {
    expect(read(textSegments(`${npub(ALICE)} hello`, nameOf))).toBe(
      "Alice hello",
    );
    expect(read(textSegments(`first\n${npub(ALICE)} hello`, nameOf))).toBe(
      "first\nAlice hello",
    );
  });

  it("puts a space only before it at the end of the text", () => {
    expect(read(textSegments(`hello ${npub(ALICE)}`, nameOf))).toBe(
      "hello Alice",
    );
    expect(read(textSegments(`hello ${npub(ALICE)}\nlast`, nameOf))).toBe(
      "hello Alice\nlast",
    );
  });

  it("leaves a name alone on its own line without padding it", () => {
    expect(read(textSegments(`a\n${npub(ALICE)}\nb`, nameOf))).toBe(
      "a\nAlice\nb",
    );
  });

  it("keeps the spacing the author wrote rather than adding to it", () => {
    // The name takes the place of the reference, so the gap the author left
    // around it is the gap the reader gets: one space stays one space, and two
    // stay two rather than becoming three.
    expect(read(textSegments(`hello ${npub(ALICE)}`, nameOf))).toBe(
      "hello Alice",
    );
    expect(read(textSegments(`hello  ${npub(ALICE)}`, nameOf))).toBe(
      "hello  Alice",
    );
    expect(read(textSegments(`${npub(ALICE)}  hello`, nameOf))).toBe(
      "Alice  hello",
    );
  });

  it("names every reference, keeping the pubkey beside the label", () => {
    const segments = textSegments(`${npub(ALICE)} met ${npub(BOB)}`, nameOf);
    expect(segments.filter((s) => s.kind === "mention")).toEqual([
      { kind: "mention", mention: { pubkey: ALICE, label: "Alice" } },
      { kind: "mention", mention: { pubkey: BOB, label: "Bob" } },
    ]);
    expect(read(segments)).toBe("Alice met Bob");
  });

  it("falls back to whatever the caller has for a name it does not know", () => {
    const unknown = "a".repeat(64);
    expect(read(textSegments(`hi ${npub(unknown)}`, nameOf))).toBe(
      `hi ${nameOf(unknown)}`,
    );
  });

  it("leaves the text alone when it names nobody", () => {
    expect(textSegments("just words", nameOf)).toEqual([
      { kind: "text", text: "just words" },
    ]);
  });

  it("names a bare npub when the caller allows one", () => {
    const bare = encodeNpub(ALICE) as string;
    expect(read(textSegments(`hi ${bare} there`, nameOf, true))).toBe(
      "hi Alice there",
    );
    // Without the caller's permission the same text is left alone.
    expect(read(textSegments(`hi ${bare} there`, nameOf))).toBe(`hi ${bare} there`);
  });

  it("gives a bare npub the same spacing rules as a prefixed one", () => {
    const bare = encodeNpub(ALICE) as string;
    expect(read(textSegments(bare, nameOf, true))).toBe("Alice");
    expect(read(textSegments(`end ${bare}`, nameOf, true))).toBe("end Alice");
    expect(read(textSegments(`${bare}\nnext`, nameOf, true))).toBe(
      "Alice\nnext",
    );
  });
});

describe("contentSegments with names", () => {
  it("shows a name in the text it was written in", () => {
    const segments = contentSegments(note(`hello ${npub(ALICE)} there`), nameOf);
    expect(segments.map((s) => s.kind)).toEqual(["text", "mention", "text"]);
    expect(segments[0]).toEqual({ kind: "text", text: "hello " });
    expect(segments[2]).toEqual({ kind: "text", text: " there" });
  });

  it("leaves the reference as written when no resolver is given", () => {
    // A client that cannot resolve names shows what the author wrote, which
    // is better than a blank or a guess.
    const segments = contentSegments(note(`hello ${npub(ALICE)}`));
    expect(segments).toEqual([
      { kind: "text", text: `hello ${npub(ALICE)}` },
    ]);
  });

  it("keeps the image split working alongside a name", () => {
    const segments = contentSegments(
      note(`hi ${npub(ALICE)}\nhttps://x.example/a.png`),
      nameOf,
    );
    // The line the author put between the name and the image survives: it is
    // the gap they chose, not leftover space.
    expect(segments.map((s) => s.kind)).toEqual([
      "text",
      "mention",
      "text",
      "image",
    ]);
    expect(segments[0]).toEqual({ kind: "text", text: "hi " });
    expect(segments[2]).toEqual({ kind: "text", text: "\n" });
  });

  it("keeps the space that separates a name from an image after it", () => {
    // Without this the name button sits flush against the picture, so the two
    // read as one thing.
    const segments = contentSegments(
      note(`${npub(ALICE)} https://x.example/a.png`),
      nameOf,
    );
    expect(segments.map((s) => s.kind)).toEqual(["mention", "text", "image"]);
    expect(segments[1]).toEqual({ kind: "text", text: " " });
  });

  it("keeps the blank line between two images", () => {
    // The blank line is a paragraph of the author's own, so closing it glues
    // the two figures together.
    const segments = contentSegments(
      note("https://x.example/1.png\n\nhttps://x.example/2.png"),
    );
    expect(segments.map((s) => s.kind)).toEqual(["image", "text", "image"]);
    expect(segments[1]).toEqual({ kind: "text", text: "\n\n" });
  });

  it("still drops the space a lone image leaves behind", () => {
    // A run with nothing written on one side of it is leftover space, and it is
    // the one case where dropping it is right.
    const segments = contentSegments(note("a https://x.example/1.png"));
    expect(segments.map((s) => s.kind)).toEqual(["text", "image"]);
  });

  it("leaves punctuation tight against the name it follows", () => {
    // `Alice , ok` is not what anyone wrote, and the author put the comma
    // against the reference on purpose.
    const read = (text: string): string =>
      contentSegments(note(text), nameOf)
        .map((s) =>
          s.kind === "text" ? s.text : s.kind === "mention" ? s.mention.label : "",
        )
        .join("");
    expect(read(`${npub(ALICE)}, ok`)).toBe("Alice, ok");
    expect(read(`${npub(ALICE)}。`)).toBe("Alice。");
    expect(read(`${npub(ALICE)}!`)).toBe("Alice!");
    expect(read(`${npub(ALICE)} ok`)).toBe("Alice ok");
  });

  it("does not let a name be read as an image", () => {
    // The scan runs on the written text, before any name is substituted, so a
    // name that looks like an address cannot become one.
    const segments = contentSegments(
      note(`see ${npub(ALICE)}`),
      () => "https://notreally.example/a.png",
    );
    expect(segments.map((s) => s.kind)).toEqual(["text", "mention"]);
  });

  it("does not drop the space a name needs when nothing follows it", () => {
    // The padding lives in the run after the name, so a run that is only
    // whitespace must not be tidied away.
    const segments = contentSegments(note(`hi ${npub(ALICE)} there`), nameOf);
    expect(segments.filter((s) => s.kind === "text")).toHaveLength(2);
  });
});
