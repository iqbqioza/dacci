import type { ContentSegment, NostrEvent } from "dacci-nostr-nips";
import { contentSegments } from "dacci-nostr-nips";
import { For, Show } from "solid-js";
import { NoteImage } from "./NoteImage.jsx";

/**
 * A post's body, with the images it carries shown where the author wrote
 * them. A post is mostly text, so the text keeps one paragraph block and each
 * image is a figure of its own: an image inside a run of prose would be sized
 * by the line it shares, which is never the size the author meant.
 *
 * The body is already the text a card should show, so a `nostr:` link whose
 * note is embedded below is not repeated here as a link.
 */
export function NoteBody(props: { event: NostrEvent }) {
  const segments = (): ContentSegment[] => contentSegments(props.event);
  const hasImages = (): boolean =>
    segments().some((segment) => segment.kind === "image");

  return (
    <Show
      when={hasImages()}
      // Without an image the text is one run, and wrapping each piece would
      // only give the paragraph somewhere to break.
      fallback={<>{segments().map(textOf).join("")}</>}
    >
      <For each={segments()}>{(segment) => renderSegment(segment)}</For>
    </Show>
  );
}

function renderSegment(segment: ContentSegment) {
  if (segment.kind === "text") {
    return <span class="whitespace-pre-wrap break-words">{segment.text}</span>;
  }
  return <NoteImage image={segment.image} />;
}

function textOf(segment: ContentSegment): string {
  return segment.kind === "text" ? segment.text : "";
}
