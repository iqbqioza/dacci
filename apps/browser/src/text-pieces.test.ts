import { describe, expect, it } from "vitest";
import { piecesAsText, textPieces } from "./text-pieces.js";

/** Every address in a piece list, in the order they were drawn. */
function linksOf(pieces: ReturnType<typeof textPieces>): string[] {
  return pieces.flatMap((piece) =>
    piece.kind === "link" ? [piece.url] : [],
  );
}

describe("textPieces", () => {
  it("reads back exactly what the author wrote, whatever is in it", () => {
    // The whole of it: what a reader reads is what the author wrote, and the
    // pieces are how that is drawn. A run that has been through the split comes
    // back word for word, however many addresses and shortcodes are in it.
    const texts = [
      "no addresses at all",
      "one https://x.example/paper here",
      "FIRST https://one.example/a SECOND https://two.example/b THIRD",
      "https://one.example/a https://two.example/b https://three.example/c",
      "leading https://one.example/a",
      "https://one.example/a trailing",
      "adjacent https://one.example/a,https://two.example/b done",
      "lines\nand https://one.example/a\nand https://two.example/b\n",
      "emoji :soapbox: with https://x.example/paper and :cat: here",
      "several https://a.example/1 https://b.example/2 https://c.example/3 https://d.example/4 end",
    ];
    for (const text of texts) {
      expect(piecesAsText(textPieces(text)), text).toBe(text);
    }
  });

  it("draws each address as a link of its own, in order", () => {
    expect(
      linksOf(
        textPieces(
          "FIRST https://one.example/a SECOND https://two.example/b THIRD",
        ),
      ),
    ).toEqual(["https://one.example/a", "https://two.example/b"]);
    expect(
      linksOf(textPieces("https://a.example/1 https://b.example/2 https://c.example/3")),
    ).toEqual(["https://a.example/1", "https://b.example/2", "https://c.example/3"]);
  });

  it("does not repeat the text around an address", () => {
    // The bug this pins: the words before each address were read from the start
    // of the string and the words after it to the end of it, so a bio with four
    // addresses rendered four times over, and a post with two rendered twice.
    const text = "alpha https://one.example/a beta";
    const pieces = textPieces(text);
    expect(pieces.filter((p) => p.kind === "text")).toHaveLength(2);
    expect(
      pieces.filter(
        (p) => p.kind === "text" && p.text.includes("alpha"),
      ),
    ).toHaveLength(1);

    // Two addresses, one copy of everything: the marker must appear once.
    const marker = "MARKER";
    const many = `${marker} https://one.example/a ${marker} https://two.example/b ${marker}`;
    const times = piecesAsText(textPieces(many)).split(marker).length - 1;
    expect(times).toBe(3);
  });

  it("leaves no empty run behind", () => {
    // An empty text node is a piece that draws nothing, and one at the end of
    // every link is how the same paragraph ends up with gaps in it.
    const pieces = textPieces("https://one.example/a tail");
    expect(pieces.every((p) => p.kind !== "text" || p.text !== "")).toBe(true);
    expect(pieces.at(-1)).toEqual({ kind: "text", text: " tail" });
  });

  it("draws the author's own emoji where they wrote them", () => {
    const emoji = [{ code: "soapbox", url: "https://x.example/s.png" }];
    const pieces = textPieces("hello :soapbox: https://x.example/paper", emoji);
    expect(pieces.filter((p) => p.kind === "emoji")).toHaveLength(1);
    // Still word for word, with the shortcode as what it stands for.
    expect(piecesAsText(pieces)).toBe("hello :soapbox: https://x.example/paper");
  });
});