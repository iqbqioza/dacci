import type { Emoji } from "dacci-nostr-nips";
import { emojify, urlSpans } from "dacci-nostr-nips";

/** One piece of a run of text: plain text, an address, or an emoji. */
export type TextPiece =
  | { kind: "text"; text: string }
  | { kind: "link"; url: string }
  | { kind: "emoji"; emoji: Emoji };

/**
 * A run of text as the pieces to draw: the author's own `:shortcode:`s as emoji,
 * and every address as a link, in the order they were written.
 *
 * The addresses are cut out first and the shortcodes looked for only in what
 * surrounds them. Doing it the other way round would let an author's `:shortcode:`
 * inside a query string split the address in half, and the link would go
 * somewhere the reader never wrote.
 *
 * **The cursor is what makes it a split rather than a repeat.** Every address has
 * to be taken out of one continuous run of the text: what is written before it,
 * then the link, then what is written after it and before the next one. Reading
 * each address against the start of the string instead — before it from zero,
 * and after it to the end — repeated everything, so a text with two addresses
 * rendered twice and a bio with four rendered twice as well. Which is why this
 * is a function of its own: it is string work with no view in it, and the bug it
 * had was invisible in a component and obvious here.
 */
export function textPieces(text: string, emojis: Emoji[] = []): TextPiece[] {
  const out: TextPiece[] = [];
  let cursor = 0;
  const write = (run: string): void => {
    if (run === "") return;
    for (const part of emojify(run, emojis)) out.push(part);
  };
  for (const span of urlSpans(text)) {
    write(text.slice(cursor, span.start));
    out.push({ kind: "link", url: span.url });
    cursor = span.end;
  }
  write(text.slice(cursor));
  return out;
}

/** What a piece shows as its own text: a link is its own address. */
export function pieceText(piece: TextPiece): string {
  if (piece.kind === "text") return piece.text;
  if (piece.kind === "link") return piece.url;
  return `:${piece.emoji.code}:`;
}

/** The pieces as the reader sees them, for comparing against the original. */
export function piecesAsText(pieces: TextPiece[]): string {
  return pieces.map(pieceText).join("");
}