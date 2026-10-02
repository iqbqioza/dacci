import type { Filter, NostrEvent } from "dacci-nostr-nips";

const MAX_CACHED = 2000;

const cache = new Map<string, NostrEvent>();

export function rememberEvents(events: NostrEvent[]): void {
  for (const event of events) {
    // Every sighting moves the entry to the back of the queue, not only the
    // first one. Keeping the position it arrived at meant the post a reader had
    // just opened — the one every re-render asks for — stayed at the front and
    // was the *first* thing evicted when the cache filled, while events nobody
    // had looked at since went on sitting there.
    //
    // The copy that stays is the first one, deliberately. `id` is a hash of the
    // event's own fields, so two events with one id can differ at most in `sig`,
    // which the id does not cover; there is no reason to let whichever relay
    // answered last decide which signature a cached post is shown with.
    const known = cache.get(event.id);
    cache.delete(event.id);
    cache.set(event.id, known ?? event);
  }
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export function lookupEvent(id: string): NostrEvent | null {
  return cache.get(id) ?? null;
}

export function clearEventCache(): void {
  cache.clear();
}

export type CacheQueryFn = (
  url: string,
  filter: Filter,
) => Promise<NostrEvent[]>;

/**
 * Resolve an event by id: cache first, then relays. Takes the first
 * relay that has the event rather than waiting for every relay, so a
 * slow or dead relay cannot stall a detail page.
 */
export async function fetchEventById(
  id: string,
  urls: string[],
  query: CacheQueryFn,
): Promise<NostrEvent | null> {
  const hit = lookupEvent(id);
  if (hit !== null) return hit;
  if (urls.length === 0) return null;
  let resolved: NostrEvent | null = null;
  const settle = async (url: string): Promise<void> => {
    try {
      const events = await query(url, { ids: [id], limit: 1 });
      const found = events.find((event) => event.id === id);
      if (found !== undefined && resolved === null) resolved = found;
    } catch {
      // Ignore: another relay may still answer.
    }
  };
  await Promise.race([
    Promise.allSettled(urls.map(settle)),
    // Cap the wait so one dead relay cannot hold the page hostage.
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (resolved === null) return null;
  rememberEvents([resolved]);
  return resolved;
}
