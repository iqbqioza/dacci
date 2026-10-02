/**
 * The scroll corrections a paged feed owes its reader.
 *
 * A feed has one control that comes and goes inside the flow: the "new arrivals"
 * row, which is only there while something has arrived. Appearing or disappearing
 * moves everything below it, and a reader scrolled into the feed watches the post
 * they were reading slide away.
 *
 * Appearing is corrected here, by the height the control pushed down. Disappearing
 * is corrected in the flush path, which removes the control and inserts the new
 * posts in the same step, so one `preservingViewport` covers both.
 *
 * The home timeline and the profile feed have the same row, and the profile feed
 * had no correction for it at all — on the view a reader is most likely to be
 * scrolled, having arrived from a link to somebody they already know.
 *
 * The load-more control also comes and goes, and used to be listed here as though
 * it needed the same care. It does not: it is the last child of the list on all
 * three feeds, so its appearing and its disappearing both happen below anything
 * the reader is looking at, and there is nothing to correct. The correction that
 * stood here was `preservingViewport` with an empty `change`, called after the
 * effect had already applied the move it was meant to compensate — so it measured
 * a layout that had not shifted, found nothing to restore, and returned. It read
 * as protection and was not.
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
    barRemoved: () => {
      barWasVisible = false;
    },
    listElement: () => list,
  };
}
