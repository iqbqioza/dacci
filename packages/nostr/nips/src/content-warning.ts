import type { NostrEvent } from "./event.js";

/**
 * NIP-36, Sensitive Content / Content Warning. An author marks a post as
 * needing the reader's approval, and the client asks for it rather than
 * deciding for them.
 *
 * The tag is `content-warning` with an optional reason. NIP-36 also allows
 * the warning to be written as a NIP-32 classified term, and both forms are
 * read: a client that only understood the plain tag would show a post its
 * author asked it not to, which is the one failure this is here to prevent.
 *
 * NIP-36's own `kind: 1984` replaceable event is not read. It is how a client
 * states its own policy rather than how a post is marked, and no client
 * publishes one, so reading it would be guessing at an intent.
 */
export const CONTENT_WARNING_KIND = 1984;
const WARNING_NAMESPACE = "content-warning";

/**
 * The reason the author gave for the warning, or an empty string when the tag
 * is there without one. `null` means the post asked for nothing.
 */
export function contentWarning(event: NostrEvent): string | null {
  const tagged = event.tags.find((tag) => tag[0] === "content-warning");
  if (tagged !== undefined) return tagged[1] ?? "";
  // NIP-32 form: `["l", <term>, <namespace>]`. The `L` tag that declares the
  // namespace is not required to read it, since the namespace is named here
  // and a missing declaration is the writer's omission, not a different word.
  const classified = event.tags.find(
    (tag) => tag[0] === "l" && tag[2] === WARNING_NAMESPACE,
  );
  return classified === undefined ? null : (classified[1] ?? "");
}

/**
 * True when the post carries a warning, however it was written. Callers that
 * only need to know there is one use this rather than testing the reason,
 * which is an empty string for a warning that gave none.
 */
export function hasContentWarning(event: NostrEvent): boolean {
  return contentWarning(event) !== null;
}
