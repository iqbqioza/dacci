import type { NostrEvent } from "./event.js";

/** NIP-01 subscription filter. */
export interface Filter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [tag: `#${string}`]: string[] | number | undefined;
}

/** True when the event satisfies every present filter condition (AND). */
export function matchesFilter(event: NostrEvent, filter: Filter): boolean {
  if (filter.ids !== undefined && !filter.ids.includes(event.id)) {
    return false;
  }
  if (filter.authors !== undefined && !filter.authors.includes(event.pubkey)) {
    return false;
  }
  if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) {
    return false;
  }
  if (filter.since !== undefined && event.created_at < filter.since) {
    return false;
  }
  if (filter.until !== undefined && event.created_at > filter.until) {
    return false;
  }
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(values)) continue;
    const tagName = key.slice(1);
    const eventValues = event.tags
      .filter((tag) => tag[0] === tagName)
      .map((tag) => tag[1]);
    if (!eventValues.some((value) => values.includes(value))) {
      return false;
    }
  }
  return true;
}
