import type { ContentSegment, NostrEvent } from "dacci-nostr-nips";
import { contentSegments, mentionedProfiles } from "dacci-nostr-nips";
import { profileLabel } from "dacci-nostr-profile";
import { createEffect, For, Show } from "solid-js";
import { shortNpub } from "../nostr.js";
import { requestProfiles, useProfile } from "../profile.js";
import { navigate, profileHash } from "../router.js";
import { NoteImage } from "./NoteImage.jsx";

/**
 * A post's body, with the images it carries shown where the author wrote them
 * and the people it names shown by name. A post is mostly text, so the text
 * keeps one paragraph block and each image is a figure of its own: an image
 * inside a run of prose would be sized by the line it shares, which is never
 * the size the author meant.
 *
 * The body is already the text a card should show, so a `nostr:` link whose
 * note is embedded below is not repeated here as a link.
 */
export function NoteBody(props: { event: NostrEvent }) {
  // The profiles a post names are asked for by the same store every other
  // name in the app uses, so one batch covers the screen.
  createEffect(() => {
    const named = mentionedProfiles(props.event);
    if (named.length > 0) requestProfiles(named);
  });

  const nameOf = (pubkey: string): string =>
    // Reading the store here is what makes the text redraw when the name
    // arrives, so this has to be called while a computation is running.
    profileLabel(useProfile(pubkey).profile) ?? shortNpub(pubkey);

  const segments = (): ContentSegment[] => contentSegments(props.event, nameOf);
  const hasImages = (): boolean =>
    segments().some((segment) => segment.kind === "image");

  return (
    <Show
      when={hasImages()}
      // Without an image the text is one run, and a segment per piece would
      // only give the paragraph somewhere to break between words.
      fallback={<>{segments().map(renderSegment)}</>}
    >
      <For each={segments()}>{(segment) => renderSegment(segment)}</For>
    </Show>
  );
}

function renderSegment(segment: ContentSegment) {
  if (segment.kind === "text") {
    return <span class="whitespace-pre-wrap break-words">{segment.text}</span>;
  }
  if (segment.kind === "mention") {
    return (
      <button
        type="button"
        // No padding of its own: the name sits exactly where the reference was
        // written, and padding on a name at the start of a line reads as a
        // space the author never wrote.
        class="text-(--accent) hover:underline"
        title="プロフィールを開く"
        onClick={(e) => {
          // The card opens the post, so opening the person the post names
          // must not also navigate away from it.
          e.stopPropagation();
          navigate(profileHash(segment.mention.pubkey));
        }}
      >
        {segment.mention.label}
      </button>
    );
  }
  return <NoteImage image={segment.image} />;
}
