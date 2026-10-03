import type { NostrEvent } from "./event.js";
import type { ProfileMention } from "./profile-reference.js";
import { textSegments } from "./profile-reference.js";
import { displayContent } from "./text-reference.js";

/**
 * One image a post shows, and what NIP-92 says about it.
 *
 * A post carries its media as plain urls in the text, and NIP-92's `imeta`
 * tags add what a client cannot know by looking: the media type, the size, the
 * text an image stands for, and another place to fetch it from if this one
 * fails. Every field is optional because a post may carry the url and nothing
 * else, which is the common case.
 */
export interface MediaRef {
  url: string;
  /** NIP-92 `m`. */
  mime?: string;
  /** NIP-92 `dim`, split into its two numbers. */
  width?: number;
  height?: number;
  /** NIP-92 `alt`: what the image shows, for a reader who cannot see it. */
  alt?: string;
  /** NIP-92 `x` or `ox`: the hash of the file. */
  hash?: string;
  /**
   * NIP-92 `fallback`, in the order the post lists them. Another place the
   * same file may be, which is what a reader is left with when the first
   * server is gone.
   */
  fallbacks: string[];
}

/**
 * A post's body in the order it was written, so an image can be shown where
 * the author put it instead of being pulled out into a gallery, and so a
 * profile the post names can be shown as the name that author gave it.
 */
export type ContentSegment =
  | { kind: "text"; text: string }
  | { kind: "image"; image: MediaRef }
  | { kind: "mention"; mention: ProfileMention };

/** Extensions a file name may end in for a browser to render it inline. */
const IMAGE_EXTENSIONS = new Set([
  "apng",
  "avif",
  "bmp",
  "gif",
  "heic",
  "heif",
  "ico",
  "jfif",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "tif",
  "tiff",
  "webp",
]);

/**
 * A url in the text. Trailing punctuation belongs to the sentence rather than
 * to the address, so it is left out of the match: a link at the end of a line
 * is almost always followed by a full stop.
 *
 * The closers are the exception, because a closer also belongs to the address:
 * `https://en.wikipedia.org/wiki/Foo_(bar)` is one page, and cutting its `)`
 * leaves a link to a page that does not exist. So a trailing `)`, `]` or `}` is
 * only dropped when the address holds nothing for it to close — see
 * `trimTrailing`.
 */
const URL = /https?:\/\/[^\s<>"'，。、）】]+/gi;
/** Punctuation that ends a sentence and never ends an address. */
const TRAILING = /[.,;:!?»”’]$/;
/** The opener each closer would have to match to belong to the address. */
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * The address without the punctuation that follows it in the sentence.
 *
 * A closer is kept whenever the address opens one it never closes, because that
 * is the shape of a url that legitimately ends in a bracket — every Wikipedia
 * article with a qualifier in its name, and every documentation url for a
 * function. Stripping it left the reader a link that goes nowhere, in the one
 * kind of address that is almost always followed by nothing at all.
 */
function trimTrailing(raw: string): string {
  let out = raw;
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (TRAILING.test(last)) {
      out = out.slice(0, -1);
      continue;
    }
    const opener = CLOSERS[last];
    if (opener === undefined) break;
    // Balance counted on the candidate, so removing this closer and finding an
    // opener left open means it was closing something the address itself holds.
    const candidate = out.slice(0, -1);
    let depth = 0;
    for (const char of candidate) {
      if (char === opener) depth += 1;
      else if (char === last) depth -= 1;
    }
    if (depth > 0) break;
    out = candidate;
  }
  return out;
}

/**
 * The path of a url, without its query or fragment. Parsed with a pattern
 * rather than the `URL` global, because this package is isomorphic and takes
 * no web globals.
 */
function pathOf(url: string): string | null {
  const match = /^https?:\/\/[^/?#]+([^?#]*)/i.exec(url);
  if (match === null) return null;
  return match[1] === "" ? "/" : match[1];
}

function extensionOf(url: string): string | null {
  const path = pathOf(url);
  if (path === null) return null;
  const match = /\.([a-z0-9]{1,8})$/i.exec(path);
  return match === null ? null : match[1].toLowerCase();
}

/**
 * True when the url names something a browser can show inline. Two ways
 * qualify: a file name that ends in an image extension, or the hash form
 * every Blossom and NIP-96 server addresses a file by, where the extension
 * may be absent and the server's own content type decides.
 */
function isImageUrl(url: string): boolean {
  const extension = extensionOf(url);
  if (extension !== null && IMAGE_EXTENSIONS.has(extension)) return true;
  if (extension !== null) return false;
  return lastHashOf(url) !== null;
}

/**
 * The hash a Blossom url carries: BUD-01 has clients read the last run of 64
 * hex characters, which is what makes the same file findable on another
 * server, so that is the form to look for.
 */
function lastHashOf(url: string): string | null {
  const path = pathOf(url);
  if (path === null) return null;
  const match = /([0-9a-fA-F]{64})(?:\.[a-z0-9]{1,8})?$/.exec(path);
  return match === null ? null : match[1].toLowerCase();
}

/** The NIP-92 tag for one url, or null when the post carries none. */
function imetaFor(event: NostrEvent, url: string): string[] | null {
  for (const tag of event.tags) {
    if (tag[0] !== "imeta") continue;
    const named = tag.find((entry) => entry.startsWith("url "));
    if (named === undefined) continue;
    if (named.slice(4) === url) return tag;
  }
  return null;
}

/** A `dim` value as NIP-92 writes it: `<width>x<height>`. */
function dimensionsOf(tag: string[]): { width?: number; height?: number } {
  const dim = tag.find((entry) => entry.startsWith("dim "));
  const match = dim?.slice(4).match(/^(\d+)x(\d+)$/);
  if (match === null || match === undefined) return {};
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * The images a post shows, in the order they were written. A url is taken as
 * an image when its name says so, and otherwise when the post's own `imeta`
 * calls it an image: the author knows what they uploaded, and a server may
 * store it under a name that tells nothing.
 */
export function imagesIn(event: NostrEvent): MediaRef[] {
  return scan(event).map((found) => found.ref);
}

/** An image and where in the text it was written. */
interface Found {
  ref: MediaRef;
  start: number;
  end: number;
}

/** One pass over the text, so a post with several images is read once. */
function scan(event: NostrEvent): Found[] {
  const text = displayContent(event);
  const out: Found[] = [];
  for (const match of urlSpans(text)) {
    const tag = imetaFor(event, match.url);
    const mime = tag?.find((entry) => entry.startsWith("m "))?.slice(2);
    const claimed = mime !== undefined && mime.startsWith("image/");
    if (!isImageUrl(match.url) && !claimed) continue;
    const alt = tag?.find((entry) => entry.startsWith("alt "))?.slice(4);
    // `ox` before `x`: the original file's hash is what identifies it on
    // another server, while `x` is the hash of what this server stored, which
    // a transform may have changed.
    const hash =
      tag?.find((entry) => entry.startsWith("ox "))?.slice(3) ??
      tag?.find((entry) => entry.startsWith("x "))?.slice(2) ??
      lastHashOf(match.url) ??
      undefined;
    out.push({
      ref: {
        url: match.url,
        mime,
        ...dimensionsOf(tag ?? []),
        alt: alt === "" ? undefined : alt,
        hash,
        fallbacks:
          tag?.filter((entry) => entry.startsWith("fallback ")).map((e) => e.slice(9)) ??
          [],
      },
      start: match.start,
      end: match.end,
    });
  }
  return out;
}

/**
 * Every url written in a run of text, and where it sits, with the punctuation
 * that ends the sentence left out of the address. Exported because what counts
 * as a url has to be one judgement: a url this misses is a link shown as plain
 * text, and a url this wrongly takes in is an image that never appears.
 */
/** An address written in a run of text, and the span it covers. */
export interface UrlSpan {
  url: string;
  start: number;
  end: number;
}

export function urlSpans(text: string): UrlSpan[] {
  const out: UrlSpan[] = [];
  const pattern = new RegExp(URL.source, "gi");
  let match = pattern.exec(text);
  while (match !== null) {
    const trimmed = trimTrailing(match[0]);
    if (trimmed !== "") {
      out.push({
        url: trimmed,
        start: match.index,
        end: match.index + trimmed.length,
      });
    }
    // A zero-length match would loop forever, so the cursor always advances.
    if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    match = pattern.exec(text);
  }
  return out;
}

/**
 * True when a span of the text sits inside one of its urls.
 *
 * A NIP-19 entity written as part of a web address is not a reference in the
 * author's own words, it is part of the address:
 * `https://primal.net/e/nevent1…` is the link every client pastes when it
 * shares a post, and taking the entity out of it both broke the link
 * (`https://primal.net/e/`) and promoted the post to an embedded quotation. A
 * `nostr:` uri inside a url is the same accident, and worse on a profile's own
 * bio, where a bare entity is otherwise a mention.
 *
 * One judgement, deliberately: the reference scan, the mention scan and the
 * address reader have to agree about where a url is, and this is where the
 * address reader lives.
 */
export function insideUrl(text: string, start: number, end: number): boolean {
  return urlSpans(text).some((span) => start < span.end && end > span.start);
}

/**
 * A post's body split into text and images, in reading order. The text keeps
 * the paragraph structure the post had, minus the urls that became images, so
 * what a reader reads is what the author wrote.
 */
export function contentSegments(
  event: NostrEvent,
  /**
   * The name to show for a pubkey the post mentions in its own text. Omit it
   * and a mention is left as the `nostr:` uri it was written as, which is what
   * a client that cannot resolve names has to show.
   */
  nameOf?: (pubkey: string) => string,
): ContentSegment[] {
  const text = displayContent(event);
  const found = scan(event);
  // Without a resolver a mention is left as the `nostr:` uri it was written
  // as, which is what a client that cannot resolve names has to show.
  const say = (run: string): ContentSegment[] =>
    nameOf === undefined ? [{ kind: "text", text: run }] : textSegments(run, nameOf);
  if (found.length === 0) return tidy(say(text));
  const out: ContentSegment[] = [];
  let cursor = 0;
  for (const image of found) {
    out.push(...say(text.slice(cursor, image.start)));
    out.push({ kind: "image", image: image.ref });
    cursor = image.end;
  }
  out.push(...say(text.slice(cursor)));
  return tidy(out);
}

/**
 * Tidies the split: the url that became an image leaves the space it was
 * written in, and the whitespace that leaves behind is collapsed the way a
 * removed `nostr:` link is, without touching the paragraphs. An image and a
 * name are what the reader is here for, so neither is ever dropped.
 *
 * A run that is nothing but whitespace is kept when something else is written on
 * both sides of it. That run is not leftover space: it is the gap between two
 * figures, or the space a name is separated from what follows it. Dropping it
 * glues a name to the image after it and closes the blank line the author put
 * between two images. A run with nothing on one side is leftover space and
 * goes, which is what the single filter was for.
 */
function tidy(segments: ContentSegment[]): ContentSegment[] {
  /** The same normalisation a written run gets, applied to a kept gap. */
  const collapse = (text: string): string =>
    text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");

  const out: ContentSegment[] = [];
  for (const [index, segment] of segments.entries()) {
    if (segment.kind === "text" && segment.text.trim() === "") {
      const before = segments[index - 1];
      const after = segments[index + 1];
      // Whitespace between two written things is a gap the author chose, so it is
      // kept — but kept the way every other run is kept. Pushed verbatim it was
      // the one run that escaped normalisation, so the same blank line rendered
      // as a single break between two words and as four between two images.
      if (before !== undefined && after !== undefined) {
        out.push({ kind: "text", text: collapse(segment.text) });
      }
      continue;
    }
    out.push(
      segment.kind === "text"
        ? { kind: "text", text: collapse(segment.text) }
        : segment,
    );
  }
  return out;
}
