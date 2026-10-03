import { describe, expect, it } from "vitest";
import { computeEventId, type NostrEvent } from "./event.js";
import { encodeNote } from "./nip19.js";
import {
  displayContent,
  embeddedEventIdWithText,
  stripReferences,
  textReferences,
} from "./text-reference.js";

const QUOTED = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
const OTHER = "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";

/** A signed note, so its id follows from the content the test builds. */
function note(content: string, tags: string[][] = []): NostrEvent {
  const base = {
    pubkey: "a".repeat(64),
    created_at: 1_700_000_000,
    kind: 1,
    tags,
    content,
  };
  return { ...base, id: computeEventId(base), sig: "s".repeat(128) };
}

const link = (id: string): string => `nostr:${encodeNote(id)}`;

describe("textReferences", () => {
  it("finds a note linked with the nostr scheme", () => {
    const content = `look at this ${link(QUOTED)} please`;
    expect(textReferences(content)).toEqual([
      { id: QUOTED, start: 13, end: 13 + link(QUOTED).length },
    ]);
  });

  it("finds a bare entity, since some clients omit the scheme", () => {
    const note1 = encodeNote(QUOTED) as string;
    expect(textReferences(`see ${note1}`)).toEqual([
      { id: QUOTED, start: 4, end: 4 + note1.length },
    ]);
  });

  it("reads every link in reading order", () => {
    const refs = textReferences(`${link(QUOTED)} and ${link(OTHER)}`);
    expect(refs.map((r) => r.id)).toEqual([QUOTED, OTHER]);
  });

  it("ignores prose and links to a person rather than a post", () => {
    // A checksum failure means the word merely looks like a reference.
    expect(textReferences("this is note1nonsense not a link at all")).toEqual([]);
    expect(textReferences("follow nostr:npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7")).toEqual(
      [],
    );
  });

  it("does not cut a longer word in half", () => {
    // The entity is followed by more word characters, so it is prose.
    const text = `${encodeNote(QUOTED)}xyz`;
    expect(textReferences(text)).toEqual([]);
  });

  it("leaves an entity that is part of a web address alone", () => {
    // `https://primal.net/e/note1…` is the permalink clients paste when they
    // share a post, and `https://njump.dev/note1…` the one they redirect through.
    // Reading the entity out of the address left the reader with a link to
    // `https://primal.net/e/` — a page that does not exist — and promoted the
    // post to an embedded quotation, because the embed falls back to a link in
    // the text. The address reader is the same one the post body is drawn with,
    // so the two have to agree about where an address is.
    const note1 = encodeNote(QUOTED) as string;
    for (const url of [
      `https://primal.net/e/${note1}`,
      `https://njump.dev/${note1}`,
      `https://x.example/?q=${note1}`,
      `https://x.example/${link(QUOTED)}`,
    ]) {
      expect(textReferences(`read ${url} now`), url).toEqual([]);
    }
    // A standalone reference beside one is still found.
    expect(
      textReferences(`read https://x.example/paper and ${link(QUOTED)}`).map(
        (r) => r.id,
      ),
    ).toEqual([QUOTED]);
  });
});

describe("embeddedEventIdWithText", () => {
  it("falls back to a link when the post carries no NIP-18 tag", () => {
    expect(embeddedEventIdWithText(note(`read ${link(QUOTED)}`))).toBe(QUOTED);
  });

  it("prefers the NIP-18 tag over the text", () => {
    const event = note(`read ${link(OTHER)}`, [["q", QUOTED]]);
    expect(embeddedEventIdWithText(event)).toBe(QUOTED);
  });

  it("reports nothing for a post that quotes nothing", () => {
    expect(embeddedEventIdWithText(note("just words"))).toBeNull();
  });
});

describe("stripReferences", () => {
  it("removes a link and tidies the whitespace it leaves", () => {
    expect(stripReferences(`before\n${link(QUOTED)}\nafter`, textReferences(`before\n${link(QUOTED)}\nafter`)))
      .toBe("before\nafter");
  });

  it("leaves the content untouched when there is nothing to remove", () => {
    expect(stripReferences("plain text", [])).toBe("plain text");
  });

  it("closes the gap a link left in the middle of a line", () => {
    // Removing only the link left both spaces it was sitting between, so the
    // words around it came out doubled, or with a line holding nothing but one
    // space.
    const between = `about ${link(QUOTED)} ok`;
    expect(stripReferences(between, textReferences(between))).toBe("about ok");

    const afterLineBreak = `before\n${link(QUOTED)} and after`;
    expect(stripReferences(afterLineBreak, textReferences(afterLineBreak))).toBe(
      "before\nand after",
    );
  });

  it("does not run the words together when it takes the gap with it", () => {
    // Taking whitespace on both sides would close the gap entirely, which reads
    // as one word.
    const spaced = `a ${link(QUOTED)} b`;
    expect(stripReferences(spaced, textReferences(spaced))).toBe("a b");
  });

  it("takes a link glued to a word as prose, not as a reference", () => {
    // The word boundary is what stops a bech32-shaped run inside a longer word
    // from being cut out of it, so nothing is removed here at all.
    const glued = `a${link(QUOTED)}b`;
    expect(textReferences(glued)).toEqual([]);
    expect(stripReferences(glued, textReferences(glued))).toBe(glued);
  });
});

describe("displayContent", () => {
  it("hides the link behind the embed the card already shows", () => {
    const content = `worth reading:\n${link(QUOTED)}`;
    expect(displayContent(note(content))).toBe("worth reading:");
  });

  it("keeps a link to a note the card does not embed", () => {
    // The tag names a different note, so dropping the link would lose it.
    const content = `about ${link(OTHER)} but quoting ${QUOTED}`;
    const event = note(content, [["q", QUOTED]]);
    expect(displayContent(event)).toBe(content);
  });

  it("returns the content unchanged for a post with no links", () => {
    expect(displayContent(note("no references here"))).toBe("no references here");
  });

  it("keeps a permalink whose path holds the entity", () => {
    // The whole chain: no `q` tag to embed, so the link in the text is all there
    // is — and the reader saw `read https://primal.net/e/ now`, with the post
    // about nothing. It also became the embedded note, so the card showed a
    // quotation of itself.
    const note1 = encodeNote(QUOTED) as string;
    const content = `read https://primal.net/e/${note1} now`;
    expect(displayContent(note(content))).toBe(content);
    expect(embeddedEventIdWithText(note(content))).toBeNull();
  });
});
