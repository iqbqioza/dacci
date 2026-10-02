import type { NostrEvent } from "dacci-nostr-nips";
import { compareEvents } from "dacci-nostr-nips";

/**
 * Prepend new arrivals above the current list, dropping anything the
 * historical pagination already loaded. The scroll maths in the timeline
 * then pins the previous first card to the same viewport offset, so new
 * entries appear above it without the view jumping.
 *
 * The result is sorted rather than concatenated. Nothing guarantees an arrival
 * is newer than what is on screen: a relay replays its stored history after a
 * reconnect, and any client with a skewed clock can post with an old timestamp.
 * Concatenating would leave that event above newer ones, and the feed would no
 * longer be in the order it claims to be.
 */
export function planFlush(
  incoming: NostrEvent[],
  current: NostrEvent[],
): { events: NostrEvent[]; added: NostrEvent[] } {
  const seen = new Set(current.map((event) => event.id));
  const added = incoming.filter((event) => !seen.has(event.id));
  return { events: [...added, ...current].sort(compareEvents), added };
}
