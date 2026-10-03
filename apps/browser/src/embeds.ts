import type { NostrEvent } from "dacci-nostr-nips";
import {
  embeddedEventIdWithText,
  embeddedNote,
  hasValidId,
  isRepost,
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
  useEmbed: (event: NostrEvent) => { event: NostrEvent | null };
  requestEmbeds: (events: Iterable<NostrEvent>) => void;
  useEmbedLoading: (getEvent: () => NostrEvent) => () => boolean;
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
  const useEmbed = (event: NostrEvent): { event: NostrEvent | null } => {
    version();
    const id = embeddedEventIdWithText(event);
    if (id === null || isDeleted(id)) return { event: null };
    // NIP-18 lets a repost carry the note inline; that needs no query.
    const inline = inlineNoteOf(event);
    if (inline !== null && inline.id === id) return { event: inline };
    return { event: store.peek(id) };
  };

  /**
   * Whether this post's embed is still being fetched, and nothing else.
   *
   * The placeholder needs the flag, not the note, and the note is what costs a
   * signature verification. Asking the full question here ran that work a second
   * time for every card on screen, on every render.
   *
   * The event arrives as a getter and is read inside the accessor, never in the
   * component body. A body read is untracked, and the card list is a `<For>`,
   * which reuses its rows *positionally* — so a body read pins the placeholder to
   * whichever post that row held when it was created. After a prepend every card
   * is showing a different post, and the row would go on asking about the old one:
   * a loading line under a card whose own embed is long since here, and none at
   * all under one that is still fetching.
   */
  const useEmbedLoading = (getEvent: () => NostrEvent): (() => boolean) => {
    return () => {
      version();
      const event = getEvent();
      const id = embeddedEventIdWithText(event);
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

/**
 * Whether this post's content is the reposted event itself rather than prose.
 *
 * NIP-18 lets a repost carry the note it reposts as JSON in its content, and
 * that object is verified once and remembered. So this is also the test for
 * whether there is any *text* to draw: a repost whose content holds the note has
 * nothing of its own to say, and printing the JSON above the note it carries
 * would put a wall of escaped braces in the reader's way.
 *
 * Reposts only, deliberately. A post of any other kind whose content happens to
 * parse as a signed event is still a post with words in it, and hiding its body
 * because its text looked like JSON would lose the text.
 *
 * Read through the same memo the embed store uses, so the question is answered
 * once per post rather than once per render.
 */
export function carriesInlineEvent(event: NostrEvent): boolean {
  return isRepost(event) && inlineNoteOf(event) !== null;
}

/** The app's single embed cache, shared by every feed card. */
const app = createEmbeds(queryRelays);

export const useEmbed = app.useEmbed;
export const useEmbedLoading = app.useEmbedLoading;
export const requestEmbeds = app.requestEmbeds;

/**
 * Drops the store, e.g. after a relay set change. The inline-note memo is keyed
 * by the post's own id and is a pure function of its fields, so an answer from
 * before a relay change is still the right one and it is left alone.
 */
export const resetEmbeds = app.reset;
