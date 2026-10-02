import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinnedBars } from "./pinned-bars.js";

/**
 * The arrivals row coming and going.
 *
 * The load-more control is corrected by `preservingViewport`, which measures real
 * layout and is tested where a DOM exists. What is testable here is the row,
 * whose correction is arithmetic on a height — and which the profile feed had no
 * correction for at all, on the view a reader is most likely to be scrolled on:
 * they arrived from a link to somebody they already follow.
 */
const BAR = 52;

let scrolled: number[];
let bars: ReturnType<typeof createPinnedBars>;

beforeEach(() => {
  scrolled = [];
  vi.stubGlobal("window", {
    scrollY: 400,
    scrollBy: (opts: { top: number }) => scrolled.push(opts.top),
    scrollTo: () => {},
  });
  bars = createPinnedBars();
  // The row is created fresh each time it appears, which is what the ref sees.
  bars.barRef({ offsetHeight: BAR } as HTMLButtonElement);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the arrivals row appearing", () => {
  it("absorbs the push down for a reader already scrolled", () => {
    // The row is inserted into the pinned header, so everything below it moves
    // down by its whole height. In an active timeline that is every few seconds.
    bars.noteBarVisibility(true);
    expect(scrolled).toEqual([BAR]);
  });

  it("absorbs it again on the next arrival", () => {
    // The second arrival is the one that used to go unnoticed: the flag left set
    // from the first, so the row created afterwards was never measured.
    bars.noteBarVisibility(true);
    bars.noteBarVisibility(false);
    bars.barRef({ offsetHeight: BAR } as HTMLButtonElement);
    bars.noteBarVisibility(true);
    expect(scrolled).toEqual([BAR, BAR]);
  });

  it("leaves a reader at the top where the row belongs", () => {
    // At the top there is nothing to hold still, and the row is what the reader
    // should be looking at.
    vi.stubGlobal("window", {
      scrollY: 0,
      scrollBy: (opts: { top: number }) => scrolled.push(opts.top),
      scrollTo: () => {},
    });
    bars.noteBarVisibility(true);
    expect(scrolled).toEqual([]);
  });

  it("does not move anything while the row is already there", () => {
    // A live feed announces arrivals one at a time and the effect re-runs for
    // each; only the first of them is an appearance.
    bars.noteBarVisibility(true);
    bars.noteBarVisibility(true);
    bars.noteBarVisibility(true);
    expect(scrolled).toEqual([BAR]);
  });
});

