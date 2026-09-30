import type { NostrEvent } from "dacci-nostr-nips";

/**
 * Prepend new arrivals above the current list, dropping anything the
 * historical pagination already loaded. The scroll maths in the timeline
 * then pins the previous first card to the same viewport offset, so new
 * entries appear above it without the view jumping.
 */
export function planFlush(
  incoming: NostrEvent[],
  current: NostrEvent[],
): { events: NostrEvent[]; added: NostrEvent[] } {
  const seen = new Set(current.map((event) => event.id));
  const added = incoming.filter((event) => !seen.has(event.id));
  return { events: [...added, ...current], added };
}
