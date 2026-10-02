import { createEffect, onCleanup, untrack } from "solid-js";

/** What every paged feed exposes, so one retry serves all of them. */
export interface PagedFeed {
  loading: () => boolean;
  loadingMore: () => boolean;
  hasMore: () => boolean;
  pendingRelays: () => string[];
  authRelays: () => string[];
  /** True when the list is empty only because the relays could not be asked. */
  failed: () => boolean;
}

/**
 * Re-attempts a feed in the background while relays are still owed an answer.
 *
 * The home timeline had this and the other two feeds did not, so a profile or a
 * notifications list that failed to load sat on its empty message with no retry
 * at all: the reader had to navigate away and come back, and nothing on screen
 * said the load had failed in the first place.
 *
 * `failed` is part of the condition because a feed whose *first* round failed has
 * nothing to scroll and so reports no more history — treating that as finished
 * is what left those two views with no way to try again.
 */
export function retryWhilePending(
  feed: PagedFeed,
  loadMore: () => void | Promise<void>,
  everyMs = 15000,
): void {
  createEffect(() => {
    // Relays waiting on credentials are excluded: they will not be asked again
    // until a signer exists, and retrying on a gate that cannot move just keeps
    // the reader on a spinner.
    const retryable = feed
      .pendingRelays()
      .filter((url) => !feed.authRelays().includes(url));
    const stuck = feed.failed();
    if (
      retryable.length === 0 ||
      feed.loading() ||
      feed.loadingMore() ||
      (!feed.hasMore() && !stuck)
    ) {
      return;
    }
    const timer = setTimeout(
      () => untrack(() => void loadMore()),
      everyMs,
    );
    onCleanup(() => clearTimeout(timer));
  });
}
