import type { ContentSegment, UrlSpan } from "dacci-nostr-nips";
import { mentionedProfiles, textSegments, urlSpans } from "dacci-nostr-nips";
import { profileLabel } from "dacci-nostr-profile";
import { createEffect, createMemo, For, Show } from "solid-js";
import { shortNpub } from "../nostr.js";
import { requestProfiles, useProfile } from "../profile.js";
import { navigate, profileHash } from "../router.js";

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
 * A run of text with the addresses in it as links.
 *
 * The address stays exactly as the author wrote it: an address is what a
 * reader needs to see to decide whether to follow it, and shortening it hides
 * where they are going. What follows it is the punctuation of the sentence, so
 * a link at the end of a line does not swallow the full stop.
 *
 * What counts as an address is one judgement shared with the image scan, so a
 * url that is an image never also shows up here as a link, and the same
 * trailing punctuation is left out of both.
 */
export function TextRun(props: { text: string }) {
  // Every piece keeps the space the author wrote, including a run that is only
  // a space, so a link never ends up glued to the word before it.
  const pieces = createMemo<Array<{ kind: "text"; text: string } | { kind: "link"; url: string }>>(() => {
    const found: UrlSpan[] = urlSpans(props.text);
    if (found.length === 0) return [{ kind: "text", text: props.text }];
    const out: Array<{ kind: "text"; text: string } | { kind: "link"; url: string }> = [];
    let cursor = 0;
    for (const span of found) {
      if (span.start > cursor) {
        out.push({ kind: "text", text: props.text.slice(cursor, span.start) });
      }
      out.push({ kind: "link", url: span.url });
      cursor = span.end;
    }
    if (cursor < props.text.length) {
      out.push({ kind: "text", text: props.text.slice(cursor) });
    }
    return out;
  });

  return (
    <span class="whitespace-pre-wrap break-words">
      <For each={pieces()}>
        {(piece) =>
          piece.kind === "text" ? (
            piece.text
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
 * Text a person wrote, with the people it names shown by name and the
 * addresses in it as links. This is the same reading of a body a post's text
 * gets, without the images: a profile's own words are shown as written, and
 * the metadata of anyone they name is asked for so the name can arrive.
 *
 * With `bare` a bare `npub1…` counts as naming someone too, not only one
 * behind its `nostr:` prefix. That belongs in a profile's own bio, where a
 * person often writes their key out to say who they are, and nowhere else.
 */
export function RichText(props: { text: string; bare?: boolean }) {
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
      <For each={segments()}>{(segment) => renderSegment(segment)}</For>
    </Show>
  );
}

// Solid does not narrow a union inside a JSX branch, so the segment is read in
// a plain function, which does narrow it.
function renderSegment(segment: ContentSegment) {
  if (segment.kind === "mention") {
    return <Mention pubkey={segment.mention.pubkey} label={segment.mention.label} />;
  }
  // An image cannot be in a piece of someone's own writing, but the reading of
  // text is shared with a post's body, so the case is handled rather than
  // pretended away.
  if (segment.kind === "image") return null;
  return <TextRun text={segment.text} />;
}