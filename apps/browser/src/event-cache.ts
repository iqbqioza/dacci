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
) => Promise<NostrEvent[] | null>;

/**
 * The events one relay's answer holds, or `null` when it gave no answer.
 *
 * A closed socket, a query that timed out, a subscription the relay never had
 * room for: none of these is a relay saying "I do not have that post", and the
 * difference is the whole question when every relay is out of reach. Kept here
 * rather than in the caller so the rule is testable and cannot be written twice.
 */
export function answerEvents(result: {
  events: NostrEvent[];
  failed: boolean;
}): NostrEvent[] | null {
  return result.failed ? null : result.events;
}

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
 * **Nobody answering is not everybody answering "no".** A relay that closed,
 * timed out, or was never asked (`query` returning `null`) has said nothing
 * about the post, and it used to be counted the moment it came back — so a deep
 * link opened while every read relay was reconnecting resolved in a few hundred
 * milliseconds with "this post does not exist", which is the one thing nobody
 * knows. Only a relay that *answered* without the post settles the question,
 * and when none of them answered the deadline does: five seconds is what a
 * reconnecting relay needs, and guessing sooner only risks telling a reader
 * their post is gone.
 *
 * Nothing is thrown away when the deadline passes. A relay that answers afterwards
 * is slow, not absent, and its answer goes into the cache — so the next attempt at
 * this id finds it without asking anyone. Telling the reader a post does not
 * exist and then forgetting the proof is the worst of both.
 *
 * And when **nobody** answered, the question is asked again. Waiting without
 * asking buys nothing: the relays are asked once, the post is not found, and the
 * reader is told it does not exist — while the only reason nothing came back is
 * that every dial failed a moment ago, which is what a network on its feet looks
 * like. A gap and a bounded number of rounds ride that out; once any relay *has*
 * answered, there is nothing left to retry, because a post one relay looked for
 * and did not find is missing.
 */
export async function fetchEventById(
  id: string,
  urls: string[],
  query: CacheQueryFn,
  /** How long to keep looking; a caller that answers sooner is not waited for. */
  deadlineMs = DEADLINE_MS,
): Promise<NostrEvent | null> {
  const hit = lookupEvent(id);
  if (hit !== null) return hit;
  if (urls.length === 0) return null;

  const endAt = Date.now() + deadlineMs;
  for (let round = 1; round <= RETRY_ROUNDS; round += 1) {
    const left = endAt - Date.now();
    if (left <= 0) return null;

    const asked = await askOnce(id, urls, query, left);
    if (asked.hit !== null) return asked.hit;
    // Somebody looked and did not find it: that is the answer, not a failure to
    // get one, and asking again would only find the same nothing.
    if (asked.answered > 0) return null;

    // Nobody answered, so this round is already over — there is nothing left to
    // wait for, and waiting out the deadline anyway is what turned a blip into a
    // dead link. A gap, and then the question again. The gap is half of whatever
    // time is left at most, so the last round always has room to be answered.
    const gap = Math.min(RETRY_GAP_MS, (endAt - Date.now()) / 2);
    if (round === RETRY_ROUNDS || gap <= 0) return null;
    await new Promise((r) => setTimeout(r, gap));
  }
  return null;
}

/** Pause between rounds, so a relay being down is not asked again instantly. */
const RETRY_GAP_MS = 500;

/** Rounds in total, the first one included: three tries, never an open loop. */
const RETRY_ROUNDS = 4;

/**
 * One round of asking every relay, settled by the first hit, by every relay
 * having answered without one, or by the deadline.
 */
async function askOnce(
  id: string,
  urls: string[],
  query: CacheQueryFn,
  deadlineMs: number,
): Promise<{ hit: NostrEvent | null; answered: number }> {
  /** The first event any relay produced, kept even when it is too late to use. */
  let arrived: NostrEvent | null = null;
  /** Relays that gave a verdict, as against relays that could not be reached. */
  let answered = 0;
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
      const found = events?.find((event) => event.id === id);
      if (found !== undefined) {
        arrived ??= found;
        // Calling a settled resolver is a no-op, so a second relay answering is
        // harmless — and every relay is still asked.
        settle?.(found);
      } else if (events !== null) {
        // A relay that looked and did not find it has answered. One that could
        // not look at all has not, and is not allowed to testify.
        answered += 1;
      }
    } catch {
      // Ignore: another relay may still answer.
    } finally {
      outstanding -= 1;
      // A round with every relay finished and no post in hand is over, whether or
      // not anybody managed to answer: the difference is what the caller does with
      // it, not how long this takes. Only a hit settles it earlier.
      if (outstanding === 0 && arrived === null) settle?.(null);
    }
  };
  const answers = Promise.allSettled(urls.map(ask));

  let deadline: ReturnType<typeof setTimeout> | undefined;
  const outOfTime = new Promise<null>((resolve) => {
    deadline = setTimeout(() => resolve(null), deadlineMs);
  });
  const winner = await Promise.race([verdict, outOfTime]);
  // Cleared either way: left pending it would keep this page's timers alive for
  // the whole deadline after an answer that arrived in twenty milliseconds.
  if (deadline !== undefined) clearTimeout(deadline);

  // A `null` here means the round is out of time, not that the post is missing;
  // only `answered` above says the latter. What arrives afterwards is slow, not
  // absent, and is kept for the next attempt rather than dropped.
  if (winner !== null) {
    rememberEvents([winner]);
    return { hit: winner, answered };
  }
  void answers.then(() => {
    if (arrived !== null) rememberEvents([arrived]);
  });
  return { hit: null, answered };
}
