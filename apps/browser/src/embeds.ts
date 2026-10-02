import type { NostrEvent } from "dacci-nostr-nips";
import {
  embeddedEventIdWithText,
  embeddedNote,
  hasValidId,
} from "dacci-nostr-nips";
import { EmbedStore } from "dacci-nostr-quotes";
import { createSignal } from "solid-js";
import { lookupEvent } from "./event-cache.js";
import { isDeleted } from "./deleted.js";
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
 * The inline note each post carries, or null, remembered by event id.
 *
 * NIP-18 lets a repost carry the note in its own content, and reading it means
 * verifying a signature — about 370× the cost of the id check the relay already
 * did. That work belongs once per post, not once per render: a card re-renders
 * whenever anything it shows changes, and the placeholder asked the same
 * question again on top of that, so one feed full of inline notes paid for the
 * same verification a dozen times over.
 *
 * Bounded like the event cache it shadows.
 */
const inlineNotes = new Map<string, NostrEvent | null>();
const MAX_INLINE_NOTES = 2000;

function inlineNoteOf(event: NostrEvent): NostrEvent | null {
  // The id is only a sound key for an event whose id is the hash of its own
  // fields. A tampered event keeps an id it no longer matches, and keying on that
  // would hand it whatever answer was cached for the id it is claiming — so an
  // id that does not check out gets no cache at all, in either direction. The
  // check is one hash; what it guards is three hundred and seventy.
  if (!hasValidId(event)) return embeddedNote(event);
  const cached = inlineNotes.get(event.id);
  if (cached !== undefined) return cached;
  const note = embeddedNote(event);
  if (inlineNotes.size >= MAX_INLINE_NOTES) inlineNotes.clear();
  inlineNotes.set(event.id, note);
  return note;
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
  useEmbedLoading: (event: NostrEvent) => () => boolean;
  reset: () => void;
} {
  const [version, setVersion] = createSignal(0);
  const store = new EmbedStore(query, {
    // A burst of cards on one screen coalesces into a single query.
    flushDelayMs: options.flushDelayMs ?? 60,
    onChange: () => setVersion((v) => v + 1),
  });

  /**
   * The note a post embeds, or null when there is nothing to show — including
   * when the note has been deleted.
   *
   * A NIP-09 request takes a post away from every list the app draws, and the
   * embed is a list too: a repost carries the note inline in its own content,
   * and any post that merely links to a `nostr:note1…` has the note's full text
   * fetched for it. Without this check the author deletes their post and its
   * text goes on being drawn inside everything that referenced it.
   */
  const useEmbed = (
    event: NostrEvent,
  ): { event: NostrEvent | null; loading: boolean } => {
    version();
    const id = embeddedEventIdWithText(event);
    if (id === null || isDeleted(id)) return { event: null, loading: false };
    // NIP-18 lets a repost carry the note inline; that needs no query.
    const inline = inlineNoteOf(event);
    if (inline !== null && inline.id === id) return { event: inline, loading: false };
    return { event: store.peek(id), loading: store.isLoading(id) };
  };

  /**
   * Whether this post's embed is still being fetched, and nothing else.
   *
   * The placeholder needs the flag, not the note, and the note is what costs a
   * signature verification. Asking the full question here ran that work a second
   * time for every card on screen, on every render.
   */
  const useEmbedLoading = (event: NostrEvent): (() => boolean) => {
    const id = embeddedEventIdWithText(event);
    return () => {
      version();
      if (id === null || isDeleted(id)) return false;
      if (inlineNoteOf(event) !== null) return false;
      return store.peek(id) === null && store.isLoading(id);
    };
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
      // Nothing to ask a relay for: a note a NIP-09 request has taken away is
      // not shown, so fetching it would only fill a cache nobody reads.
      if (id === null || isDeleted(id)) continue;
      const inline = inlineNoteOf(event);
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
    useEmbedLoading,
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
export const useEmbedLoading = app.useEmbedLoading;
export const requestEmbeds = app.requestEmbeds;

/** Drops the cache, e.g. after a relay set change. */
export const resetEmbeds = app.reset;
