import { createEffect, createSignal, onCleanup, untrack } from "solid-js";

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
 *
 * Nothing is scheduled while the tab is hidden. A background timer still fires —
 * browsers throttle it, they do not stop it — so every fifteen seconds a page
 * nobody is looking at asked every relay again, over a metered connection, with
 * the radio woken for a result that would be read minutes or hours later. The
 * retry goes out when the tab is looked at again, and goes out then rather than
 * starting another fifteen seconds of waiting first: the reader has just come
 * back to the feed.
 *
 * `isVisible` is a parameter so the visibility part can be exercised without a
 * document; the default is the one the browser answers.
 */
export function retryWhilePending(
  feed: PagedFeed,
  loadMore: () => void | Promise<void>,
  everyMs = 15000,
  isVisible: () => boolean = () =>
    typeof document === "undefined" || document.visibilityState !== "hidden",
): void {
  const [visible, setVisible] = createSignal(isVisible());
  if (typeof document !== "undefined") {
    const onChange = (): void => {
      setVisible(isVisible());
    };
    document.addEventListener("visibilitychange", onChange);
    onCleanup(() => document.removeEventListener("visibilitychange", onChange));
  }

  // Whether the last run of the effect below found the tab hidden. Kept outside
  // the effect so it survives across its runs, which is what makes "the tab has
  // just come back" a thing that can be told apart from "the feed changed".
  let wasHidden = false;

  createEffect(() => {
    const hidden = !visible();
    const returning = !hidden && wasHidden;
    wasHidden = hidden;
    if (hidden) return;
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
      returning ? 0 : everyMs,
    );
    onCleanup(() => clearTimeout(timer));
  });
}