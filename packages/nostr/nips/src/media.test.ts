import { describe, expect, it } from "vitest";
import {
  contentSegments,
  imagesIn,
  urlSpans,
  type ContentSegment,
  type NostrEvent,
} from "./index.js";

function note(content: string, tags: string[][] = []): NostrEvent {
  return {
    id: "a".repeat(64),
    pubkey: "b".repeat(64),
    created_at: 1700000000,
    kind: 1,
    tags,
    content,
    sig: "c".repeat(128),
  };
}

const HASH = "b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553";

/** The text of each run, with the images left out. */
function textOf(segments: ContentSegment[]): string[] {
  return segments.flatMap((s) => (s.kind === "text" ? [s.text] : []));
}

describe("imagesIn", () => {
  it("finds an image by its file name", () => {
    const images = imagesIn(note("look https://x.example/a.png"));
    expect(images).toHaveLength(1);
    expect(images[0].url).toBe("https://x.example/a.png");
  });

  it("finds the hash form every Blossom server addresses a file by", () => {
    // BUD-01 has clients read the last run of 64 hex characters, and the
    // extension may be absent, so the app's own uploads land here too.
    expect(imagesIn(note(`https://cdn.example/${HASH}.webp`))[0].url).toBe(
      `https://cdn.example/${HASH}.webp`,
    );
    const bare = imagesIn(note(`https://cdn.example/${HASH}`))[0];
    expect(bare.url).toBe(`https://cdn.example/${HASH}`);
    expect(bare.hash).toBe(HASH);
  });

  it("leaves a file that is not an image alone", () => {
    expect(imagesIn(note(`https://x.example/${HASH}.bin`))).toEqual([]);
    expect(imagesIn(note("https://x.example/paper.pdf"))).toEqual([]);
    expect(imagesIn(note("https://nostr.build/"))).toEqual([]);
  });

  it("takes a url the author called an image, whatever it is named", () => {
    // A server may store a file under a name that says nothing, and the
    // author knows what they uploaded.
    const event = note("pic https://x.example/opaque", [
      ["imeta", "url https://x.example/opaque", "m image/avif"],
    ]);
    expect(imagesIn(event)).toHaveLength(1);
  });

  it("ignores an imeta tag for a url the post does not carry", () => {
    const event = note("nothing here", [["imeta", "url https://x.example/a.png", "m image/png"]]);
    expect(imagesIn(event)).toEqual([]);
  });

  it("reads everything NIP-92 puts in the tag", () => {
    const event = note("photo https://x.example/a.jpg", [
      [
        "imeta",
        "url https://x.example/a.jpg",
        "m image/jpeg",
        "dim 3024x4032",
        "alt a scenic photo",
        "x 1234",
        "fallback https://b.example/a.jpg",
        "fallback https://c.example/a.jpg",
      ],
    ]);
    expect(imagesIn(event)[0]).toEqual({
      url: "https://x.example/a.jpg",
      mime: "image/jpeg",
      width: 3024,
      height: 4032,
      alt: "a scenic photo",
      hash: "1234",
      fallbacks: ["https://b.example/a.jpg", "https://c.example/a.jpg"],
    });
  });

  it("keeps several images in the order they were written", () => {
    const images = imagesIn(note("a https://x.example/1.png b https://x.example/2.gif"));
    expect(images.map((i) => i.url)).toEqual([
      "https://x.example/1.png",
      "https://x.example/2.gif",
    ]);
  });

  it("leaves the full stop off a link at the end of a sentence", () => {
    expect(imagesIn(note("see https://x.example/a.png."))[0].url).toBe(
      "https://x.example/a.png",
    );
  });

  it("reads the original hash when a server transformed the file", () => {
    // NIP-92's `ox` is the hash of the file as it was uploaded, which is what
    // identifies it; `x` is the stored one.
    const event = note("https://x.example/a.png", [
      ["imeta", "url https://x.example/a.png", "ox abc", "x def"],
    ]);
    expect(imagesIn(event)[0].hash).toBe("abc");
  });
});

describe("contentSegments", () => {
  it("leaves a post with no media as one run of text", () => {
    expect(contentSegments(note("just words"))).toEqual([
      { kind: "text", text: "just words" },
    ]);
  });

  it("puts the image where the author wrote it", () => {
    const segments = contentSegments(note("before\nhttps://x.example/a.png\nafter"));
    expect(segments.map((s) => s.kind)).toEqual(["text", "image", "text"]);
    expect(textOf(segments)).toEqual(["before\n", "\nafter"]);
  });

  it("takes the url out of the text it was written in", () => {
    const segments = contentSegments(note("look at this https://x.example/a.png ok"));
    expect(textOf(segments).join("")).not.toContain("a.png");
    expect(textOf(segments).join("")).toContain("look at this");
  });

  it("collapses the space a removed url leaves without touching paragraphs", () => {
    const segments = contentSegments(note("a https://x.example/1.png\n\n\n\nb"));
    expect(textOf(segments).join("")).toBe("a \n\nb");
  });

  it("keeps a link that is not an image in the text", () => {
    const segments = contentSegments(note("read https://x.example/paper.pdf now"));
    expect(segments).toEqual([
      { kind: "text", text: "read https://x.example/paper.pdf now" },
    ]);
  });

  it("drops the space a lone image leaves behind", () => {
    const segments = contentSegments(note("https://x.example/a.png"));
    expect(segments).toEqual([
      { kind: "image", image: { url: "https://x.example/a.png", fallbacks: [] } },
    ]);
  });

  it("does not turn a quoted note's own link into an image twice", () => {
    // The `nostr:` link is removed from the text before it is split, so the
    // text and the images can never disagree about what was written.
    const event = note("see nostr:note1" + "1".repeat(58) + " and https://x.example/a.png", [
      ["q", "1".repeat(64)],
    ]);
    const segments = contentSegments(event);
    expect(segments.filter((s) => s.kind === "image")).toHaveLength(1);
  });
});

describe("urlSpans", () => {
  it("finds an address and where it sits in the text", () => {
    expect(urlSpans("read https://x.example/paper now")).toEqual([
      { url: "https://x.example/paper", start: 5, end: 28 },
    ]);
  });

  it("leaves the punctuation of the sentence out of the address", () => {
    // The full stop is the author's, not part of where the link goes.
    expect(urlSpans("see https://x.example/paper.")[0].url).toBe(
      "https://x.example/paper",
    );
    expect(urlSpans("(https://x.example/paper)")[0].url).toBe(
      "https://x.example/paper",
    );
    expect(urlSpans("https://x.example/paper、です")[0].url).toBe(
      "https://x.example/paper",
    );
  });

  it("finds every address, in the order they were written", () => {
    expect(urlSpans("a https://x.example/1 b https://y.example/2 c").map((s) => s.url)).toEqual([
      "https://x.example/1",
      "https://y.example/2",
    ]);
  });

  it("finds an address that carries its own punctuation inside it", () => {
    // Only the tail is the sentence's, so a query string survives.
    expect(urlSpans("https://x.example/a?b=1&c=2.")[0].url).toBe(
      "https://x.example/a?b=1&c=2",
    );
  });

  it("finds an address on its own line", () => {
    expect(urlSpans("first\nhttps://x.example/paper\nlast")[0].start).toBe(6);
  });

  it("finds nothing in text without an address", () => {
    expect(urlSpans("nostr:" + "1".repeat(58))).toEqual([]);
    expect(urlSpans("mailto:someone@example.com")).toEqual([]);
  });

  it("finds an http address as well as https", () => {
    expect(urlSpans("http://x.example/p")[0].url).toBe("http://x.example/p");
  });

  it("does not stall on text with no address between two urls", () => {
    // The scanner has to advance even when a match is empty, or this loops.
    expect(urlSpans("https://x.example/a https://y.example/b")).toHaveLength(2);
  });
});

describe("the gap between two images", () => {
  it("collapses it the same way it collapses anywhere else", () => {
    // A run of whitespace between two written things is kept — it is the gap the
    // author chose, not leftover space — but it used to be pushed verbatim, the
    // one run that skipped normalisation. So the same blank line came out as one
    // break between two words and as four between two images, and which one you
    // got depended on what happened to be on either side of it.
    // The gap is the only text left once the two urls have become images, so
    // what is compared is the width of the break: the same number of newlines
    // whichever side of it is a word.
    const breakWidth = (runs: string[]): number =>
      Math.max(0, ...runs.map((t) => (t.match(/\n+/g) ?? [""])[0].length));
    const betweenImages = textOf(
      contentSegments(note("https://a.example/1.png\n\n\n\nhttps://a.example/2.png")),
    );
    const betweenWords = textOf(contentSegments(note("one\n\n\n\ntwo")));
    expect(breakWidth(betweenImages)).toBe(breakWidth(betweenWords));
    expect(betweenImages.some((t) => t.includes("\n\n\n"))).toBe(false);
    expect(betweenWords.some((t) => t.includes("\n\n\n"))).toBe(false);
  });

  it("still leaves a gap, so two figures are not glued together", () => {
    // The reason the run is kept at all. Collapsing is not the same as deleting.
    const runs = textOf(
      contentSegments(note("https://a.example/1.png\n\n\n\nhttps://a.example/2.png")),
    );
    expect(runs.some((t) => t.trim() === "" && t.includes("\n"))).toBe(true);
  });

  it("keeps trailing spaces off the ends of the kept gap", () => {
    // The other half of the same normalisation, and the one that shows in the
    // rendered gap's width.
    const runs = textOf(
      contentSegments(note("https://a.example/1.png  \n  \n  https://a.example/2.png")),
    );
    expect(runs.some((t) => /[ \t]+\n/.test(t))).toBe(false);
  });
});
