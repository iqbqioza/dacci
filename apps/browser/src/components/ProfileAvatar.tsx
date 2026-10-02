import {
  createEffect,
  createMemo,
  createSignal,
  Show,
} from "solid-js";
import { withoutEmojis } from "dacci-nostr-nips";
import { requestProfiles, useProfile } from "../profile.js";
import { shortId } from "../nostr.js";
import { EmojiText } from "./RichText.jsx";

/**
 * Identity pieces for a pubkey, resolved from NIP-01 metadata. Every piece
 * feeds the same store, which coalesces the whole screen into one batched
 * request and retries the users a relay could not answer.
 */

/** Round avatar, with the first initial as fallback. */
export function ProfileAvatar(props: {
  pubkey: string;
  size?: number;
  /** Extra classes, e.g. a ring where it overlaps a banner. */
  class?: string;
}) {
  const [broken, setBroken] = createSignal(false);
  createEffect(() => {
    setBroken(false);
    requestProfiles([props.pubkey]);
  });
  const picture = createMemo(() => {
    const url = useProfile(props.pubkey).profile?.picture;
    return url === undefined || broken() ? null : url;
  });
  const initial = createMemo(() => {
    const profile = useProfile(props.pubkey).profile;
    const label = profile?.displayName ?? profile?.name ?? profile?.nip05;
    // A name may open with a NIP-30 emoji, and the letter an avatar stands for
    // has to be a letter: the shortcode would give a colon.
    const plain = withoutEmojis(label ?? "", profile?.emojis ?? []).trim();
    const first = plain[0] ?? profile?.emojis[0]?.code[0] ?? "";
    return (first || shortId(props.pubkey).slice(0, 1)).toUpperCase();
  });
  const size = () => props.size ?? 40;

  return (
    // `block` matters: an inline box ignores overflow, so the image would
    // not be clipped into a circle outside a flex row.
    <span
      class={`block shrink-0 overflow-hidden rounded-full bg-(--fill) ${props.class ?? ""}`}
      style={{ width: `${size()}px`, height: `${size()}px` }}
    >
      <Show
        when={picture()}
        fallback={
          <span
            class="flex h-full w-full items-center justify-center text-sm text-(--ink-quiet)"
            aria-hidden="true"
          >
            {initial()}
          </span>
        }
      >
        {(url) => (
          <img
            src={url()}
            alt=""
            class="h-full w-full object-cover"
            loading="lazy"
            decoding="async"
            // The picture is on someone else's host, which has no business
            // knowing which post, or which reader, pulled it.
            referrerpolicy="no-referrer"
            onError={() => setBroken(true)}
          />
        )}
      </Show>
    </span>
  );
}

/**
 * Display name, falling back to the short pubkey while the metadata is
 * unknown so a card never renders an empty header.
 *
 * The name is drawn with the author's own NIP-30 emoji, which NIP-30 asks for
 * on a profile. The letters come from the same text with the shortcodes taken
 * out, so a name is still searchable and comparable as words.
 */
export function ProfileName(props: { pubkey: string; class?: string }) {
  const profile = createMemo(() => useProfile(props.pubkey).profile);
  const label = createMemo(
    () =>
      profile()?.displayName ??
      profile()?.name ??
      profile()?.nip05 ??
      shortId(props.pubkey),
  );
  return (
    // Block level so the ellipsis applies: a long name must stop before
    // the time, not run underneath it.
    <span
      class={`block truncate font-medium text-(--ink) ${
        props.class ?? ""
      }`}
    >
      <EmojiText text={label()} emojis={profile()?.emojis} />
    </span>
  );
}
