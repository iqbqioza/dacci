import type { ContentSegment, Emoji, NostrEvent } from "dacci-nostr-nips";
import { contentSegments, emojisIn, mentionedProfiles } from "dacci-nostr-nips";
import { createEffect, For, Show } from "solid-js";
import { requestProfiles } from "../profile.js";
import { nameOf, Mention, TextRun } from "./RichText.jsx";
import { NoteImage } from "./NoteImage.jsx";

/**
 * A post's body, with the images it carries shown where the author wrote them,
 * the people it names shown by name, and the author's NIP-30 custom emoji drawn
 * where they wrote the shortcode. A post is mostly text, so the text keeps one
 * paragraph block and each image is a figure of its own: an image inside a run
 * of prose would be sized by the line it shares, which is never the size the
 * author meant. An emoji is the exception, because an emoji is a character the
 * author wrote in the middle of a sentence.
 *
 * The body is already the text a card should show, so a `nostr:` link whose
 * note is embedded below is not repeated here as a link.
 */
export function NoteBody(props: { event: NostrEvent }) {
  // The profiles a post names are asked for by the same store every other
  // name in the app uses, so one batch covers the screen.
  createEffect(() => {
    const named = mentionedProfiles(props.event.content);
    if (named.length > 0) requestProfiles(named);
  });

  // The shortcodes come with the post, so there is nothing to ask a relay for.
  const emojis = (): Emoji[] => emojisIn(props.event);
  const segments = (): ContentSegment[] => contentSegments(props.event, nameOf);
  const hasImages = (): boolean =>
    segments().some((segment) => segment.kind === "image");

  return (
    <Show
      when={hasImages()}
      // Without an image the text is one run, and a segment per piece would
      // only give the paragraph somewhere to break between words.
      fallback={<>{segments().map((segment) => renderSegment(segment, emojis()))}</>}
    >
      <For each={segments()}>
        {(segment) => renderSegment(segment, emojis())}
      </For>
    </Show>
  );
}

function renderSegment(segment: ContentSegment, emojis: Emoji[]) {
  if (segment.kind === "text") return <TextRun text={segment.text} emojis={emojis} />;
  if (segment.kind === "mention") {
    return (
      <Mention pubkey={segment.mention.pubkey} label={segment.mention.label} />
    );
  }
  return <NoteImage image={segment.image} />;
}