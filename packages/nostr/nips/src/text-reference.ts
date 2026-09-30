import type { NostrEvent } from "./event.js";
import { embeddedEventId } from "./activity.js";
import { decodeEventReference } from "./nip19.js";

/**
 * A note referenced from a post's text, in the NIP-19 `nostr:` URI form that
 * clients write when they quote by link instead of using NIP-18 tags.
 */
export interface TextReference {
  /** Hex id of the referenced event. */
  id: string;
  /** Offset of the reference within the content. */
  start: number;
  /** Offset just past the reference. */
  end: number;
}

/**
 * Matches a `nostr:` URI holding a single-event entity: `note1…`, `nevent1…`
 * and the non-standard `event1…`. The body is bounded to bech32's charset so
 * trailing prose is never swallowed, and the lookahead keeps a longer word
 * from being cut in half.
 */
const REFERENCE = /(?:nostr:)?\b(nevent1|note1|event1)[023456789acdefghjklmnpqrstuvwxyz]{20,}\b/gi;

/**
 * Every note a post references from its own text, in reading order. The
 * bech32 checksum decides what is real, so ordinary words are never treated
 * as references even when they begin with the same letters.
 */
export function textReferences(content: string): TextReference[] {
  const out: TextReference[] = [];
  // One regex instance is stateful, so a fresh literal is used per call.
  const pattern = new RegExp(REFERENCE.source, "gi");
  let match = pattern.exec(content);
  while (match !== null) {
    const id = decodeEventReference(match[0]);
    // Overlapping matches are impossible with exec, but a zero-length match
    // would loop forever, so the cursor always advances past the text.
    if (id !== null) {
      out.push({ id, start: match.index, end: match.index + match[0].length });
    }
    if (match[0].length === 0) pattern.lastIndex += 1;
    match = pattern.exec(content);
  }
  return out;
}

/**
 * The note a post embeds: its NIP-18 tags first, then a `nostr:` link in its
 * text, which is how many clients quote without the tags. A post names at
 * most one embed, so a card never shows two quotes side by side.
 */
export function embeddedEventIdWithText(event: NostrEvent): string | null {
  return embeddedEventId(event) ?? textReferences(event.content)[0]?.id ?? null;
}

/**
 * The span a reference occupies, widened to take its whole line when the
 * reference is all the line holds. A link alone on a line was a paragraph of
 * its own, so removing only the link would leave a blank line behind.
 */
function removalRange(content: string, ref: TextReference): TextReference {
  let start = ref.start;
  let end = ref.end;
  while (start > 0 && (content[start - 1] === " " || content[start - 1] === "\t")) {
    start -= 1;
  }
  while (end < content.length && (content[end] === " " || content[end] === "\t")) {
    end += 1;
  }
  const opensLine = start === 0 || content[start - 1] === "\n";
  const closesLine = end === content.length || content[end] === "\n";
  if (!opensLine || !closesLine) return ref;
  // The line's own break goes with it, or the next line would start a
  // paragraph that no longer exists.
  return { id: ref.id, start, end: closesLine && end < content.length ? end + 1 : end };
}

/**
 * The post's text with the given references removed, so a note that is
 * rendered as an embed is not also printed as a raw `nostr:` link. Line
 * breaks around a removed reference are tidied, because stripping the middle
 * of a line would otherwise leave the paragraph looking broken.
 */
export function stripReferences(
  content: string,
  references: TextReference[],
): string {
  if (references.length === 0) return content;
  const ranges = [...references]
    .sort((a, b) => a.start - b.start)
    .map((ref) => removalRange(content, ref));
  let out = "";
  let cursor = 0;
  for (const ref of ranges) {
    // A reference inside an already removed span is covered by it.
    if (ref.start < cursor) continue;
    out += content.slice(cursor, ref.start);
    cursor = ref.end;
  }
  out += content.slice(cursor);
  // Collapse the whitespace a removal leaves behind, but keep the paragraph
  // structure a post actually had.
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * What a card should render for its body: the text with every `nostr:` link
 * whose note is shown as an embed removed, so the same note never appears
 * both as a link and as an embed.
 *
 * A link to a note the card does not embed stays in the text. Dropping it
 * would silently lose the reference, and the reader would see a post that
 * says nothing at all.
 */
export function displayContent(event: NostrEvent): string {
  const references = textReferences(event.content);
  if (references.length === 0) return event.content;
  const embedded = embeddedEventIdWithText(event);
  if (embedded === null) return event.content;
  const shown = references.filter((ref) => ref.id === embedded);
  if (shown.length === 0) return event.content;
  return stripReferences(event.content, shown);
}
