import type { NostrEvent } from "./event.js";
import { insideUrl, type ContentSegment } from "./media.js";
import { decodeProfileReference } from "./nip19.js";

/** A person a post names, and the text to show for them. */
export interface ProfileMention {
  pubkey: string;
  /**
   * The author's own name for themselves, or a shortened `npub` for a profile
   * no relay can answer for. Either way it is one label, so a card shows the
   * same person the same way in the header and in the text.
   */
  label: string;
}

/**
 * A profile a post names in its own text, written as the NIP-19 `npub` entity:
 * `nostr:npub1…`.
 *
 * A name is what a reader recognises, so a post that says who it is talking
 * about should read as that person's name rather than as a bech32 string. The
 * reference stays in the event: this is a reading of the text, not a rewrite
 * of it, so the note keeps saying what the author wrote and the name can
 * change with the metadata.
 */
export interface ProfileReference {
  /** Hex pubkey of the profile named. */
  pubkey: string;
  /** Offset of the reference within the content. */
  start: number;
  /** Offset just past the reference. */
  end: number;
}

/**
 * Matches an `npub` entity, with its `nostr:` prefix optional. The body is
 * bounded to bech32's charset so trailing prose is never swallowed, and the
 * checksum decides what is real, so an ordinary word is never taken for a
 * name.
 *
 * Whether the prefix counts is the caller's decision: in a post, an `npub` is
 * part of a `nostr:` uri the author chose to write, while in a profile's own
 * bio it is also how the person names themselves, which is the one place a
 * bare `npub1…` is a reference.
 */
/**
 * Matches either spelling of a profile reference: the bare `npub` entity, and
 * the `nprofile` entity NIP-27 asks writers to use for a mention, which carries
 * relay hints alongside the key. The body is bounded to bech32's charset so
 * trailing prose is never swallowed, and the checksum decides what is real, so
 * an ordinary word is never taken for a name.
 *
 * Whether the prefix counts is the caller's decision: in a post, a reference is
 * part of a `nostr:` uri the author chose to write, while in a profile's own bio
 * it is also how the person names themselves, which is the one place a bare
 * entity is a reference.
 */
const PROFILE =
  /\b(?:nostr:)?((?:npub|nprofile)1[023456789acdefghjklmnpqrstuvwxyz]{20,})\b/gi;

/**
 * Every profile a post names in its own text, in reading order.
 *
 * With `bare` the prefix is optional, so a bare `npub1…` counts as a reference
 * too. That belongs in a profile's bio and nowhere else: in a post a bare
 * `npub1…` is as likely to be a key someone pasted to be looked up as it is a
 * person being written about.
 */
export function profileReferences(
  content: string,
  bare = false,
): ProfileReference[] {
  const out: ProfileReference[] = [];
  // One regex instance is stateful, so a fresh literal is used per call.
  const pattern = new RegExp(PROFILE.source, "gi");
  let match = pattern.exec(content);
  while (match !== null) {
    // The prefix is part of the match rather than beside it, so the span covers
    // exactly what the author wrote either way.
    const prefixed = match[0].length > match[1].length;
    // A word that begins like an npub but fails the checksum is not one, and
    // the text keeps it rather than losing it.
    if (prefixed || bare) {
      // Either spelling resolves to the one thing a mention needs: the pubkey.
      const pubkey = decodeProfileReference(match[1]);
      // Unless it is part of an address. A `nostr:` uri inside a url is the
      // author's link to somewhere, not a person they are writing about, and
      // drawing it out left the reader with a url missing its own middle — and
      // on a profile's own bio, where a bare entity is otherwise a mention, a
      // profile link became a chip pointing at the reader.
      if (
        pubkey !== null &&
        !insideUrl(content, match.index, match.index + match[0].length)
      ) {
        out.push({
          pubkey,
          start: match.index,
          end: match.index + match[0].length,
        });
      }
    }
    if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    match = pattern.exec(content);
  }
  return out;
}

/**
 * The text a card should show, with every `nostr:npub1…` standing on its own
 * as the name of the person it names.
 *
 * A name is a word, so it is separated from the words around it: a space goes
 * on each side that has prose next to it, and none where the name starts or
 * ends the line. A space that is already there is left as it is, so the
 * author's own spacing survives. The space lives in the neighbouring run of
 * text rather than in the name, which keeps the name exactly the name.
 */
export function textSegments(
  text: string,
  nameOf: (pubkey: string) => string,
  /**
   * Accept a bare `npub1…` as a reference as well as one behind its `nostr:`
   * prefix. This is for a profile's own bio, which is the one place a person
   * writes an npub to mean themselves.
   */
  bare = false,
): ContentSegment[] {
  const references = profileReferences(text, bare);
  if (references.length === 0) return [{ kind: "text", text }];
  const out: ContentSegment[] = [];
  let cursor = 0;
  /** A space decided after a name, carried into the run that follows it. */
  let trailing = "";
  for (const reference of references) {
    const before = text.slice(cursor, reference.start);
    const lead = spaceBefore(before);
    if (before + lead !== "") out.push({ kind: "text", text: before + lead });
    out.push({
      kind: "mention",
      mention: {
        pubkey: reference.pubkey,
        label: nameOf(reference.pubkey),
      },
    });
    cursor = reference.end;
    trailing = needsSpaceAfter(text, cursor) ? " " : "";
  }
  const rest = trailing + text.slice(cursor);
  if (rest !== "") out.push({ kind: "text", text: rest });
  return out;
}

/**
 * A space before the name, unless it begins the text or a line, or the author
 * already left one there.
 */
function spaceBefore(before: string): string {
  if (before === "") return "";
  return /[^\s]$/.test(before) ? " " : "";
}

/**
 * A space after the name, unless it ends the text or a line — or unless what
 * follows is punctuation, which belongs to the word before it. `Alice , ok` is
 * not what anyone wrote, so the same rule the address reader uses to leave the
 * trailing full stop out of a link is used here.
 */
function needsSpaceAfter(text: string, from: number): boolean {
  const rest = text.slice(from);
  if (rest === "") return false;
  return /^[^\s]/.test(rest) && !PUNCTUATION.test(rest);
}

/**
 * Punctuation that binds to the word before it. ASCII punctuation as the address
 * reader has it, and the CJK forms that take no space in Japanese at all.
 */
const PUNCTUATION = /^[,.;:!?)\]}»”’、。、．：；！？）】』」〉》]/;

/** The profiles a post names, so a client can ask for their metadata. */
export function mentionedProfiles(
  content: string,
  bare = false,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const reference of profileReferences(content, bare)) {
    if (seen.has(reference.pubkey)) continue;
    seen.add(reference.pubkey);
    out.push(reference.pubkey);
  }
  return out;
}
