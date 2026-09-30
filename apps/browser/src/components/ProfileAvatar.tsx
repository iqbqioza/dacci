import {
  createEffect,
  createMemo,
  createSignal,
  Show,
} from "solid-js";
import { requestProfiles, useProfile } from "../profile.js";
import { shortId } from "../nostr.js";

/**
 * Identity pieces for a pubkey, resolved from NIP-01 metadata. Every piece
 * feeds the same store, which coalesces the whole screen into one batched
 * request and retries the users a relay could not answer.
 */

/** Round avatar, with the first initial as fallback. */
export function ProfileAvatar(props: { pubkey: string; size?: number }) {
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
    return (label ?? shortId(props.pubkey)).slice(0, 1).toUpperCase();
  });
  const size = () => props.size ?? 40;

  return (
    <span
      class="shrink-0 overflow-hidden rounded-full bg-(--dads-solid-gray-200)"
      style={{ width: `${size()}px`, height: `${size()}px` }}
    >
      <Show
        when={picture()}
        fallback={
          <span
            class="flex h-full w-full items-center justify-center text-sm text-(--dads-solid-gray-600)"
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
      class={`block truncate font-medium text-(--dads-solid-gray-900) ${
        props.class ?? ""
      }`}
    >
      {label()}
    </span>
  );
}
