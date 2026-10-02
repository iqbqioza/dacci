import { preservingViewport } from "./viewport.js";

/**
 * The scroll corrections a paged feed owes its reader.
 *
 * A feed has two controls that come and go inside the flow: the "new arrivals"
 * row, which is only there while something has arrived, and the load-more button,
 * which is there until the history runs out. Either one appearing or
 * disappearing moves everything below it, and a reader scrolled into the feed
 * watches the post they were reading slide away.
 *
 * Appearing is corrected here, by the height the control pushed down. Disappearing
 * is corrected in the flush path, which removes the control and inserts the new
 * posts in the same step, so one `preservingViewport` covers both.
 *
 * The home timeline and the profile feed have the same pair, and the profile feed
 * had neither — a profile is where a reader is most likely to be scrolled, having
 * arrived from a link to somebody they already know.
 */
export interface PinnedBars {
  /** The list the controls sit above; the anchor for any correction. */
  listRef: (el: HTMLDivElement | undefined) => void;
  /** The pinned container, so its height is known to the viewport helper. */
  headerRef: (el: HTMLDivElement | undefined) => void;
  /** The arrivals row, so its own height is known. */
  barRef: (el: HTMLButtonElement | undefined) => void;
  /** The pinned container's height, for anchoring below it rather than under it. */
  headerHeight: () => number;
  /** Call when the arrivals row appears, with whether it is appearing now. */
  noteBarVisibility: (visible: boolean) => void;
  /** Call when the load-more control appears or disappears. */
  noteLoadMoreVisibility: (shown: boolean) => void;
  /** Call from the flush, which accounts for the row's own removal. */
  barRemoved: () => void;
  /** The list element, for anchoring a correction that changes the list. */
  listElement: () => HTMLDivElement | undefined;
}

export function createPinnedBars(): PinnedBars {
  let list: HTMLDivElement | undefined;
  let header: HTMLDivElement | undefined;
  let bar: HTMLButtonElement | undefined;
  let barWasVisible = false;
  let loadMoreWasVisible = false;

  return {
    listRef: (el) => {
      list = el;
    },
    headerRef: (el) => {
      header = el;
    },
    barRef: (el) => {
      bar = el;
      // A fresh row is a fresh appearance, however many rows came before it.
      // Solid never calls a ref with `undefined`, so without this the flag left
      // set by the first arrival would swallow every one after it.
      barWasVisible = false;
    },
    headerHeight: () => header?.offsetHeight ?? 0,
    noteBarVisibility: (visible) => {
      if (!visible || barWasVisible) return;
      barWasVisible = true;
      // Only the row's own height shifts the list: the tab row above it is always
      // there, so it moves no content when the row appears.
      const height = bar?.offsetHeight ?? 0;
      if (height <= 0 || window.scrollY <= 0) return;
      window.scrollBy({ top: height, behavior: "instant" });
    },
    noteLoadMoreVisibility: (shown) => {
      if (shown === loadMoreWasVisible) return;
      loadMoreWasVisible = shown;
      preservingViewport(list, () => undefined, header?.offsetHeight ?? 0);
    },
    barRemoved: () => {
      barWasVisible = false;
    },
    listElement: () => list,
  };
}
