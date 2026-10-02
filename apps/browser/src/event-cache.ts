import type { Filter, NostrEvent } from "dacci-nostr-nips";

const MAX_CACHED = 2000;

/** How long a deep link waits for a relay before giving up on finding the post. */
export const DEADLINE_MS = 5000;

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
 * Resolve an event by id: cache first, then relays.
 *
 * The **first** relay that has the event answers, and the rest are not waited
 * for — which is what this function's own comment claimed and what it did not do.
 * `Promise.allSettled` waits for every relay, so one dead relay held a deep link
 * open for the whole deadline even after another relay had answered in twenty
 * milliseconds. The deadline is a deadline for *finding* the post, not for every
 * relay to finish.
 *
 * Nothing is thrown away when the deadline passes. A relay that answers afterwards
 * is slow, not absent, and its answer goes into the cache — so the next attempt at
 * this id finds it without asking anyone. Telling the reader a post does not
 * exist and then forgetting the proof is the worst of both.
 */
export async function fetchEventById(
  id: string,
  urls: string[],
  query: CacheQueryFn,
): Promise<NostrEvent | null> {
  const hit = lookupEvent(id);
  if (hit !== null) return hit;
  if (urls.length === 0) return null;

  /** The first event any relay produced, kept even when it is too late to use. */
  let arrived: NostrEvent | null = null;
  let outstanding = urls.length;
  let settle: ((event: NostrEvent | null) => void) | undefined;
  // Settled by a hit, or by every relay having answered and none of them holding
  // it. The second case matters as much as the first: a post that was deleted is
  // answered by *every* relay with nothing, and waiting out the whole deadline to
  // learn that would make the commonest case the slowest.
  const verdict = new Promise<NostrEvent | null>((resolve) => {
    settle = resolve;
  });

  const ask = async (url: string): Promise<void> => {
    try {
      const events = await query(url, { ids: [id], limit: 1 });
      const found = events.find((event) => event.id === id);
      if (found !== undefined) {
        arrived ??= found;
        // Calling a settled resolver is a no-op, so a second relay answering is
        // harmless — and every relay is still asked.
        settle?.(found);
      }
    } catch {
      // Ignore: another relay may still answer.
    } finally {
      outstanding -= 1;
      if (outstanding === 0 && arrived === null) settle?.(null);
    }
  };
  const answers = Promise.allSettled(urls.map(ask));

  let deadline: ReturnType<typeof setTimeout> | undefined;
  const outOfTime = new Promise<null>((resolve) => {
    deadline = setTimeout(() => resolve(null), DEADLINE_MS);
  });
  const winner = await Promise.race([verdict, outOfTime]);
  // Cleared either way: left pending it would keep this page's timers alive for
  // the whole deadline after an answer that arrived in twenty milliseconds.
  if (deadline !== undefined) clearTimeout(deadline);

  if (winner !== null) {
    rememberEvents([winner]);
    return winner;
  }
  void answers.then(() => {
    if (arrived !== null) rememberEvents([arrived]);
  });
  return null;
}
