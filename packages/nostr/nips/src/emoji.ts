import type { NostrEvent } from "./event.js";

/**
 * NIP-30 custom emoji.
 *
 * A shortcode is defined by the event that uses it, in an `emoji` tag:
 *
 *     ["emoji", <shortcode>, <image-url>, <emoji-set-address>]
 *
 * so the definitions travel with the post. Nothing has to be looked up to draw
 * one, and a post whose author has since changed their emoji set still draws.
 *
 * The fourth element points at a kind 30030 emoji set (NIP-51) the emoji comes
 * from. Drawing the event that carries the tag does not need it, so it is only
 * read to tell a real set address from something else.
 */

/** A shortcode and the image it stands for. */
export interface Emoji {
  /** What the author wrote between the colons. */
  code: string;
  /** Where the image is. */
  url: string;
}

/**
 * A shortcode may be only letters, digits, hyphens and underscores. NIP-30 says
 * so, and it is also what keeps a colon inside prose or a URL from opening one.
 */
const SHORTCODE = /^[A-Za-z0-9_-]+$/;

/** `kind:pubkey:d` of a kind 30030 emoji set, the address the tag may carry. */
const SET_ADDRESS = /^30030:([0-9a-fA-F]{64}):(.*)$/;

/** True for the address NIP-30 puts in the fourth element of an emoji tag. */
export function isEmojiSetAddress(value: string | undefined): boolean {
  if (value === undefined) return false;
  const match = SET_ADDRESS.exec(value);
  return match !== null;
}

/**
 * The shortcodes an event defines, in the order it lists them. A shortcode
 * listed twice keeps its first image: the list is read top to bottom and the
 * first one is the author's own order.
 */
export function emojisIn(event: NostrEvent | null): Emoji[] {
  if (event === null) return [];
  const out: Emoji[] = [];
  const seen = new Set<string>();
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag[0] !== "emoji") continue;
    const code = tag[1];
    const url = tag[2];
    if (typeof code !== "string" || !SHORTCODE.test(code)) continue;
    if (typeof url !== "string" || url === "") continue;
    // NIP-30 makes the address optional, and the emoji is defined by the
    // shortcode and the image — the address only ever says which set it came
    // from. The comment above used to say a tag with an unusable address was "a
    // mistake, and the image is still the one the author wrote", and then drop it,
    // so an author who wrote a slightly wrong address lost the emoji entirely
    // rather than the attribution. The address is read for nothing else, so it is
    // not read at all.
    const address = tag[3];
    if (address !== undefined && typeof address !== "string") continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({ code, url });
  }
  return out;
}

/** A piece of a run of text: either words, or one emoji the author defined. */
export type Emojified =
  | { kind: "text"; text: string }
  | { kind: "emoji"; emoji: Emoji };

/** `:shortcode:` as NIP-30 writes it in content. */
const REFERENCE = /:([A-Za-z0-9_-]+):/g;

/**
 * A run of text with the author's shortcodes standing as images.
 *
 * A `:name:` the event does not define stays as written. Guessing at an unknown
 * shortcode would turn a colon-wrapped word someone wrote into an image of
 * nothing, and the word is what they meant.
 */
export function emojify(text: string, emojis: Emoji[]): Emojified[] {
  if (emojis.length === 0 || !text.includes(":")) return [{ kind: "text", text }];
  const known = new Map(emojis.map((emoji) => [emoji.code, emoji]));
  const pattern = new RegExp(REFERENCE.source, "g");
  const out: Emojified[] = [];
  let cursor = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    const emoji = known.get(match[1]);
    if (emoji === undefined) {
      // A zero-length match would loop forever, so the cursor always advances.
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
      match = pattern.exec(text);
      continue;
    }
    if (match.index > cursor) {
      out.push({ kind: "text", text: text.slice(cursor, match.index) });
    }
    out.push({ kind: "emoji", emoji });
    cursor = match.index + match[0].length;
    match = pattern.exec(text);
  }
  if (cursor < text.length) out.push({ kind: "text", text: text.slice(cursor) });
  return out;
}

/**
 * A run of text with the author's shortcodes taken out.
 *
 * For the places that need the words rather than the picture: the letter an
 * avatar stands for, or anything that is compared as text. A name that begins
 * with an emoji would otherwise begin with a colon.
 */
export function withoutEmojis(text: string, emojis: Emoji[]): string {
  if (emojis.length === 0 || !text.includes(":")) return text;
  return emojify(text, emojis)
    .map((part) => (part.kind === "text" ? part.text : ""))
    .join("");
}