import type { MediaRef } from "dacci-nostr-nips";
import { createMemo, createSignal, Show } from "solid-js";

/**
 * One image from a post, shown where the author wrote it.
 *
 * NIP-92's `imeta` tag is what makes this bearable: `dim` gives the box its
 * shape before the bytes arrive, `alt` says what the image shows, and
 * `fallback` is somewhere else to fetch the same file from when this server
 * is gone — which for a post read years later is the normal case rather than
 * the exception. A server that cannot be reached leaves the url as a link,
 * because a broken image says nothing while the address still works.
 */
export function NoteImage(props: {
  image: MediaRef;
  /** A quoted note is a link itself, so its image is not a second target. */
  plain?: boolean;
}) {
  // The url in play, which moves along to the next fallback when one fails.
  const [source, setSource] = createSignal(props.image.url);
  const [tried, setTried] = createSignal<string[]>([props.image.url]);
  const [failed, setFailed] = createSignal(false);
  const ratio = createMemo(() => {
    const { width, height } = props.image;
    return width !== undefined && height !== undefined && height > 0
      ? `${width} / ${height}`
      : undefined;
  });

  /** Moves to the next place the post says the file may be, or gives up. */
  function onError(): void {
    const next = props.image.fallbacks.find((url) => !tried().includes(url));
    if (next === undefined) {
      setFailed(true);
      return;
    }
    setTried([...tried(), next]);
    setSource(next);
  }

  return (
    <Show
      when={!failed()}
      fallback={
        <a
          class="block text-sm break-all text-(--accent) underline"
          href={props.image.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          {props.image.url}
        </a>
      }
    >
      <img
        src={source()}
        // A file's type is in the url or in the tag, so the browser is told
        // rather than left to guess from the response.
        alt={props.image.alt ?? ""}
        class="mt-2 w-full rounded-2xl border border-(--line) object-cover"
        style={ratio() === undefined ? undefined : `aspect-ratio: ${ratio()}`}
        loading="lazy"
        decoding="async"
        // The image is on someone else's host, which has no business knowing
        // which post, or which reader, pulled it.
        referrerpolicy="no-referrer"
        onError={onError}
        onClick={(e) => {
          // The card opens the post, so the image opens the file instead.
          e.stopPropagation();
          if (props.plain === true) return;
          window.open(source(), "_blank", "noopener,noreferrer");
        }}
      />
      <Show when={props.image.alt !== undefined}>
        {/* A span and not a paragraph: a post's body is itself a paragraph, and
            a paragraph inside a paragraph is not valid markup even where a
            browser draws it. Block display gives the same line under the image. */}
        <span class="mt-1 block text-xs text-(--ink-muted)">{props.image.alt}</span>
      </Show>
    </Show>
  );
}
