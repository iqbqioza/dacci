import type { NostrEvent } from "dacci-nostr-nips";
import { embeddedEventIdWithText, embeddedNote } from "dacci-nostr-nips";
import { EmbedStore } from "dacci-nostr-quotes";
import { createSignal } from "solid-js";
import { lookupEvent } from "./event-cache.js";
import { getConnection } from "./nostr.js";
import { useRelays } from "./relays.js";

/** Resolves a batch of embedded note ids from the read relays. */
async function queryRelays(ids: string[]): Promise<NostrEvent[]> {
  // An embed is a read, so only read-capable relays are asked.
  const urls = useRelays().readRelays();
  if (urls.length === 0) return [];
  // One REQ for the whole batch. Relays cap filter sizes, so the batch
  // store keeps batches small rather than sending every id at once.
  const filter = { ids, limit: ids.length };
  const settled = await Promise.allSettled(
    urls.map(async (url) => {
      const result = await getConnection(url).query(filter, 4000);
      return result.failed ? [] : result.events;
    }),
  );
  return settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

/**
 * The app-wide embed cache. Bumped on every change so views re-read it, and
 * built over the event cache so a repost of a post already on screen costs
 * no request. The factory exists so tests can drive the same wiring.
 */
export function createEmbeds(
  query: (ids: string[]) => Promise<NostrEvent[]>,
  options: { flushDelayMs?: number } = {},
): {
  store: EmbedStore;
  useEmbed: (event: NostrEvent) => { event: NostrEvent | null; loading: boolean };
  requestEmbeds: (events: Iterable<NostrEvent>) => void;
  reset: () => void;
} {
  const [version, setVersion] = createSignal(0);
  const store = new EmbedStore(query, {
    // A burst of cards on one screen coalesces into a single query.
    flushDelayMs: options.flushDelayMs ?? 60,
    onChange: () => setVersion((v) => v + 1),
  });

  /**
   * The note a post embeds: the repost's own JSON content when it carries
   * one, otherwise the resolved note from the store. Null when the post
   * embeds nothing, which keeps the card free of a placeholder.
   */
  const useEmbed = (
    event: NostrEvent,
  ): { event: NostrEvent | null; loading: boolean } => {
    version();
    const id = embeddedEventIdWithText(event);
    if (id === null) return { event: null, loading: false };
    // NIP-18 lets a repost carry the note inline; that needs no query.
    const inline = embeddedNote(event);
    if (inline !== null && inline.id === id)
      return { event: inline, loading: false };
    return { event: store.peek(id), loading: store.isLoading(id) };
  };

  /**
   * Queues the embeds of a batch of posts. A note the app already holds,
   * from a feed it has loaded or from the inline content of the repost, is
   * adopted instead of queried.
   */
  const requestEmbeds = (events: Iterable<NostrEvent>): void => {
    const ids: string[] = [];
    for (const event of events) {
      const id = embeddedEventIdWithText(event);
      if (id === null) continue;
      const inline = embeddedNote(event);
      if (inline !== null && inline.id === id) {
        store.put(inline);
        continue;
      }
      const cached = lookupEvent(id);
      if (cached !== null) {
        store.put(cached);
        continue;
      }
      ids.push(id);
    }
    store.request(ids);
  };

  return {
    store,
    useEmbed,
    requestEmbeds,
    // The version bump matters: a view holding a stale entry must re-read.
    reset: () => {
      store.clear();
      setVersion((v) => v + 1);
    },
  };
}

/** The app's single embed cache, shared by every feed card. */
const app = createEmbeds(queryRelays);

export const useEmbed = app.useEmbed;
export const requestEmbeds = app.requestEmbeds;

/** Drops the cache, e.g. after a relay set change. */
export const resetEmbeds = app.reset;
