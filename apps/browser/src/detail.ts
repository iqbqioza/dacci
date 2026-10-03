import type { NostrEvent } from "dacci-nostr-nips";
import { createSignal } from "solid-js";
import { lookupEvent } from "./event-cache.js";

/** Fetches one post by id. Injected so tests need no relays. */
export type DetailQuery = (id: string) => Promise<NostrEvent | null>;

/** What a note's own page shows while it resolves the post. */
export interface DetailState {
  /** The post, once it is known. */
  event: () => NostrEvent | null;
  /** True while the post is being fetched. */
  loading: () => boolean;
  /** True when no relay has the post, so it was deleted or never existed. */
  failed: () => boolean;
}

/**
 * Resolves the post a detail page is showing.
 *
 * Two rules matter here. A post already in the event cache costs no request,
 * so a deep link opened from a feed renders at once. And a resolution that
 * finishes after the reader moved on is dropped, so a slow relay cannot
 * replace the post they are now looking at.
 */
export function createDetail(query: DetailQuery): DetailState & {
  resolve: (id: string, isCurrent: () => boolean) => Promise<void>;
} {
  const [event, setEvent] = createSignal<NostrEvent | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);

  const resolve = async (
    id: string,
    isCurrent: () => boolean,
  ): Promise<void> => {
    if (id === "") return;
    const cached = lookupEvent(id);
    if (cached !== null) {
      // Guarded like the network path below: the docstring promises a late
      // resolution never replaces the post being looked at, and the cache hit
      // used to skip the check because it resolves synchronously. A reused
      // store resolving for a stale id would otherwise overwrite the current
      // post with no network involved at all.
      if (!isCurrent()) return;
      setEvent(cached);
      setLoading(false);
      setFailed(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    const found = await query(id);
    // The reader may have moved to another post while this was in flight.
    if (!isCurrent()) return;
    setEvent(found);
    setLoading(false);
    // A relay answers with nothing when the post was deleted, so say that
    // plainly instead of leaving a blank page behind.
    setFailed(found === null);
  };

  return { event, loading, failed, resolve };
}
