import type { ContentSegment, Emoji, NostrEvent } from "dacci-nostr-nips";
import { contentSegments, emojisIn, mentionedProfiles } from "dacci-nostr-nips";
import { createEffect, Index } from "solid-js";
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
export function NoteBody(props: {
  event: NostrEvent;
  /**
   * The body is not the post: it is a quotation or an excerpt, and everything
   * around it already opens somewhere. An image would otherwise be a second,
   * competing target — a tap meant for the quoted post opening the raw file
   * instead, which is the one thing inside the embed that goes somewhere else
   * from every other part of it.
   */
  plain?: boolean;
}) {
  // The profiles a post names are asked for by the same store every other
  // name in the app uses, so one batch covers the screen.
  createEffect(() => {
    const named = mentionedProfiles(props.event.content);
    if (named.length > 0) requestProfiles(named);
  });

  // The shortcodes come with the post, so there is nothing to ask a relay for.
  const emojis = (): Emoji[] => emojisIn(props.event);
  const segments = (): ContentSegment[] => contentSegments(props.event, nameOf);

  return (
    /* Keyed by position, not by the segment itself, and for every post rather
       than only the ones carrying an image.
       `segments()` is recomputed whenever a profile name arrives anywhere on the
       page, and it returns a fresh array each time. Keying on identity — or
       mapping over it, which is not keyed at all — throws the whole body away
       with it: every mention button the reader had focused is destroyed
       mid-interaction, and an image loses which of its addresses have already
       been tried. The number of segments does not depend on any name, so a row
       keeps its place and its state. */
    <Index each={segments()}>
      {(segment) => renderSegment(segment(), emojis(), props.plain === true)}
    </Index>
  );
}

function renderSegment(
  segment: ContentSegment,
  emojis: Emoji[],
  plain: boolean,
) {
  if (segment.kind === "text") return <TextRun text={segment.text} emojis={emojis} />;
  if (segment.kind === "mention") {
    return (
      <Mention pubkey={segment.mention.pubkey} label={segment.mention.label} />
    );
  }
  return <NoteImage image={segment.image} plain={plain} />;
}