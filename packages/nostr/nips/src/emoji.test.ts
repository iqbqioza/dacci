import { describe, expect, it } from "vitest";
import {
  emojify,
  emojisIn,
  isEmojiSetAddress,
  withoutEmojis,
  type Emojified,
} from "./emoji.js";

const AUTHOR = "1".repeat(64);
const SET = "30030:79c2cae114ea28a981e7559b4fe7854a473521a8d22a66bbab9fa248eb820ff6:blobcats";

function note(tags: string[][], content = "x"): unknown {
  return {
    id: "a".repeat(64),
    pubkey: AUTHOR,
    created_at: 1700000000,
    kind: 1,
    tags,
    content,
    sig: "c".repeat(128),
  };
}

/** The text as a reader reads it, with the emoji left as their shortcode. */
function read(parts: Emojified[]): string {
  return parts
    .map((part) => (part.kind === "text" ? part.text : `:${part.emoji.code}:`))
    .join("");
}

describe("emojisIn", () => {
  it("reads the shortcode and its image", () => {
    expect(
      emojisIn(
        note([["emoji", "soapbox", "https://x/soapbox.png"]]) as never,
      ),
    ).toEqual([{ code: "soapbox", url: "https://x/soapbox.png" }]);
  });

  it("takes the set address when the tag names one", () => {
    expect(
      emojisIn(
        note([["emoji", "blobcat", "https://x/b.png", SET]]) as never,
      ),
    ).toEqual([{ code: "blobcat", url: "https://x/b.png" }]);
  });

  it("keeps the first image when a shortcode is listed twice", () => {
    const found = emojisIn(
      note([
        ["emoji", "dup", "https://x/first.png"],
        ["emoji", "dup", "https://x/second.png"],
      ]) as never,
    );
    expect(found).toHaveLength(1);
    expect(found[0].url).toBe("https://x/first.png");
  });

  it("leaves out a tag that is not an emoji the author could have used", () => {
    // NIP-30 allows only alphanumerics, hyphens and underscores in a
    // shortcode, and an address that is not a real set is a mistake.
    expect(
      emojisIn(
        note([
          ["emoji", "has space", "https://x/a.png"],
          ["emoji", "bad", "https://x/b.png", "not-an-address"],
          ["emoji", "nourl"],
          ["emoji"],
          ["t", "notemoji", "https://x/c.png"],
          ["emoji", "ok-1_2", "https://x/d.png"],
        ]) as never,
      ).map((emoji) => emoji.code),
    ).toEqual(["ok-1_2"]);
  });

  it("reads nothing from an event with no emoji tags", () => {
    expect(emojisIn(note([["t", "x"]]) as never)).toEqual([]);
    expect(emojisIn(null)).toEqual([]);
  });
});

describe("isEmojiSetAddress", () => {
  it("takes a kind 30030 address", () => {
    expect(isEmojiSetAddress(SET)).toBe(true);
    // The d tag may be empty: a set with no name is still a set.
    expect(
      isEmojiSetAddress(
        "30030:79c2cae114ea28a981e7559b4fe7854a473521a8d22a66bbab9fa248eb820ff6:",
      ),
    ).toBe(true);
  });

  it("takes nothing else", () => {
    expect(isEmojiSetAddress(undefined)).toBe(false);
    expect(isEmojiSetAddress("30023:aa:bb")).toBe(false);
    expect(isEmojiSetAddress("npub1abc")).toBe(false);
    expect(isEmojiSetAddress("30030:nothex:bb")).toBe(false);
  });
});

describe("emojify", () => {
  const soapbox = { code: "soapbox", url: "https://x/soapbox.png" };
  const blob = { code: "ablobcatrainbow", url: "https://x/blob.png" };

  it("stands a shortcode the author defined as an image", () => {
    const parts = emojify("Hello :soapbox: there", [soapbox]);
    expect(parts).toEqual([
      { kind: "text", text: "Hello " },
      { kind: "emoji", emoji: soapbox },
      { kind: "text", text: " there" },
    ]);
    expect(read(parts)).toBe("Hello :soapbox: there");
  });

  it("stands several in one run of text", () => {
    const parts = emojify(
      ":soapbox: 😂 :ablobcatrainbow: yolo",
      [soapbox, blob],
    );
    expect(parts.filter((p) => p.kind === "emoji")).toHaveLength(2);
    expect(read(parts)).toBe(":soapbox: 😂 :ablobcatrainbow: yolo");
  });

  it("stands a shortcode whose name has hyphens and digits", () => {
    const odd = { code: "blob-cat_2", url: "https://x/odd.png" };
    expect(emojify("hi :blob-cat_2:", [odd])).toEqual([
      { kind: "text", text: "hi " },
      { kind: "emoji", emoji: odd },
    ]);
  });

  it("leaves a shortcode the author did not define as written", () => {
    // Guessing at an unknown shortcode would turn a colon-wrapped word into an
    // image of nothing.
    expect(emojify("hello :unknown: there", [soapbox])).toEqual([
      { kind: "text", text: "hello :unknown: there" },
    ]);
  });

  it("leaves a word that only looks like one alone", () => {
    expect(emojify("time 10:30 now", [soapbox])).toEqual([
      { kind: "text", text: "time 10:30 now" },
    ]);
  });

  it("does not mistake a url's scheme for a shortcode", () => {
    const text = "see https://x.example/a now";
    expect(emojify(text, [soapbox])).toEqual([{ kind: "text", text }]);
  });

  it("stands one alone in the text, with no words around it", () => {
    const parts = emojify(":soapbox:", [soapbox]);
    expect(parts).toEqual([{ kind: "emoji", emoji: soapbox }]);
  });

  it("keeps the text around a shortcode at either end", () => {
    expect(read(emojify(":soapbox: start", [soapbox]))).toBe(":soapbox: start");
    expect(read(emojify("end :soapbox:", [soapbox]))).toBe("end :soapbox:");
  });

  it("hands back one run when the author defined nothing", () => {
    const text = "nothing here";
    expect(emojify(text, [])).toEqual([{ kind: "text", text }]);
  });

  it("hands back one run when the text has no colon at all", () => {
    // The common case: a post with emoji tags on it but nothing in the text
    // that uses one must not be split up for nothing.
    const text = "plain words";
    expect(emojify(text, [soapbox])).toEqual([{ kind: "text", text }]);
  });

  it("handles two shortcodes with nothing between them", () => {
    const parts = emojify(":soapbox::ablobcatrainbow:", [soapbox, blob]);
    expect(parts.filter((p) => p.kind === "emoji")).toHaveLength(2);
  });

  it("keeps newlines and blank lines where the author put them", () => {
    const parts = emojify("a\n\n:soapbox:\nb", [soapbox]);
    expect(read(parts)).toBe("a\n\n:soapbox:\nb");
    expect(parts[1]).toEqual({ kind: "emoji", emoji: soapbox });
  });
});

describe("withoutEmojis", () => {
  const soapbox = { code: "soapbox", url: "https://x/soapbox.png" };

  it("takes the shortcodes out and leaves the words", () => {
    // A name that begins with an emoji would otherwise begin with a colon,
    // which is what an avatar's letter and any comparison as text would see.
    expect(withoutEmojis(":soapbox: Alex", [soapbox])).toBe(" Alex");
    expect(withoutEmojis("Alex :soapbox:", [soapbox])).toBe("Alex ");
  });

  it("leaves a shortcode the author did not define alone", () => {
    expect(withoutEmojis(":unknown: Alex", [soapbox])).toBe(":unknown: Alex");
  });

  it("hands back the very string when there is nothing to take out", () => {
    const text = "Alex Gleason";
    expect(withoutEmojis(text, [])).toBe(text);
    expect(withoutEmojis(text, [soapbox])).toBe(text);
  });
});