import type { ContentSegment, Emoji, Emojified } from "dacci-nostr-nips";
import {
  emojify,
  mentionedProfiles,
  textSegments,
} from "dacci-nostr-nips";
import { profileLabel } from "dacci-nostr-profile";
import { createEffect, createMemo, For, Index, Show } from "solid-js";
import { shortNpub } from "../nostr.js";
import { requestProfiles, useProfile } from "../profile.js";
import { navigate, profileHash } from "../router.js";
import { textPieces, type TextPiece } from "../text-pieces.js";

/**
 * The name to show for a pubkey, read from the one store every name in the app
 * comes from. Reading the store here is what makes the text redraw when a name
 * arrives, so this has to be called while a computation is running.
 */
export function nameOf(pubkey: string): string {
  return profileLabel(useProfile(pubkey).profile) ?? shortNpub(pubkey);
}

/**
 * A person a post or a profile names, shown by the name they go by.
 *
 * No padding of its own: the name sits exactly where the reference was written,
 * and padding on a name at the start of a line reads as a space the author
 * never wrote.
 */
export function Mention(props: { pubkey: string; label: string }) {
  return (
    <button
      type="button"
      class="text-(--accent) hover:underline"
      title="プロフィールを開く"
      onClick={(e) => {
        // The card around a post opens the post, so opening the person the
        // post names must not also navigate away from it.
        e.stopPropagation();
        navigate(profileHash(props.pubkey));
      }}
    >
      {props.label}
    </button>
  );
}

/**
 * One NIP-30 custom emoji, drawn inside the line it stands in.
 *
 * It sits on the text baseline rather than as a figure of its own: an emoji is
 * a character the author wrote in the middle of a sentence, so it takes the
 * height of the words beside it and flows with them.
 */
export function EmojiMark(props: { emoji: Emoji }) {
  return (
    <img
      src={props.emoji.url}
      // The shortcode is what the author wrote and what a reader who cannot
      // see the image needs to know, so it is also what a reader hears.
      alt={`:${props.emoji.code}:`}
      title={`:${props.emoji.code}:`}
      class="inline-block size-[1.15em] align-[-0.2em]"
      loading="lazy"
      decoding="async"
      referrerpolicy="no-referrer"
    />
  );
}

/** A piece of a run of text: words, an emoji, or an address. */
type Piece = TextPiece;

/**
 * A run of text with the author's custom emoji and the addresses in it drawn as
 * they are meant to be read.
 *
 * An emoji stands where the shortcode was written and takes no space of its
 * own, so `:soapbox:` in the middle of a sentence reads as one character and
 * not as a gap. The address stays exactly as the author wrote it: an address is
 * what a reader needs to see to decide whether to follow it, and shortening it
 * hides where they are going. What follows it is the punctuation of the
 * sentence, so a link at the end of a line does not swallow the full stop.
 *
 * The split itself is `textPieces`, which is a plain function over a string: a
 * text with two addresses used to render twice here, because each address was
 * read against the start of the string instead of against the end of the last
 * one, and a component is no place to be looking for that.
 */
export function TextRun(props: { text: string; emojis?: Emoji[] }) {
  // Every piece keeps the space the author wrote, including a run that is only
  // a space, so a link never ends up glued to the word before it.
  const pieces = createMemo<Piece[]>(() => textPieces(props.text, props.emojis ?? []));

  return (
    <span class="whitespace-pre-wrap break-words">
      <For each={pieces()}>
        {(piece) =>
          piece.kind === "text" ? (
            piece.text
          ) : piece.kind === "emoji" ? (
            <EmojiMark emoji={piece.emoji} />
          ) : (
            <a
              href={piece.url}
              // A new tab, because the address leaves Nostr entirely and a
              // same-tab hop would have the router treat it as a route.
              target="_blank"
              rel="noopener noreferrer"
              // No padding: a link sits where the address was written.
              class="text-(--accent) hover:underline [overflow-wrap:anywhere]"
              title={piece.url}
              onClick={(e) => {
                // The card around a post opens the post, so following the
                // address must not also navigate away from it.
                e.stopPropagation();
              }}
            >
              {piece.url}
            </a>
          )
        }
      </For>
    </span>
  );
}

/**
 * Short words with the author's custom emoji drawn, and nothing else.
 *
 * A display name is a name, not a paragraph: it has no address to follow and
 * nobody in it to resolve. Only the emoji are drawn, so a name can never end up
 * holding a link inside the button that opens the profile.
 */
export function EmojiText(props: { text: string; emojis?: Emoji[] }) {
  const parts = createMemo(() => emojify(props.text, props.emojis ?? []));
  return (
    <For each={parts()}>
      {(part) =>
        part.kind === "text" ? part.text : <EmojiMark emoji={part.emoji} />
      }
    </For>
  );
}

/**
 * Text a person wrote, with the people it names shown by name, their custom
 * emoji drawn and the addresses in it as links. This is the same reading of a
 * body a post's text gets, without the images: a profile's own words are shown
 * as written, and the metadata of anyone they name is asked for so the name can
 * arrive.
 *
 * With `bare` a bare `npub1…` counts as naming someone too, not only one
 * behind its `nostr:` prefix. That belongs in a profile's own bio, where a
 * person often writes their key out to say who they are, and nowhere else.
 */
export function RichText(props: {
  text: string;
  bare?: boolean;
  /** The NIP-30 shortcodes the writing came with. */
  emojis?: Emoji[];
}) {
  // The people the text names are asked for by the same store every other
  // name in the app uses, so one batch covers the screen.
  createEffect(() => {
    const named = mentionedProfiles(props.text, props.bare === true);
    if (named.length > 0) requestProfiles(named);
  });

  const segments = (): ContentSegment[] =>
    textSegments(props.text, nameOf, props.bare === true);

  return (
    <Show when={segments().length > 0}>
      {/* Keyed by position, so a name arriving redraws the one mention that
          gained it instead of rebuilding the whole run around it. */}
      <Index each={segments()}>
        {(segment) => renderSegment(segment(), props.emojis)}
      </Index>
    </Show>
  );
}

// Solid does not narrow a union inside a JSX branch, so the segment is read in
// a plain function, which does narrow it.
function renderSegment(segment: ContentSegment, emojis: Emoji[] = []) {
  if (segment.kind === "mention") {
    return <Mention pubkey={segment.mention.pubkey} label={segment.mention.label} />;
  }
  // An image cannot be in a piece of someone's own writing, but the reading of
  // text is shared with a post's body, so the case is handled rather than
  // pretended away.
  if (segment.kind === "image") return null;
  return <TextRun text={segment.text} emojis={emojis} />;
}