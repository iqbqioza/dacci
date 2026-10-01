import { goBackOrHome } from "../router.js";

/**
 * The bar at the top of a page that has a link of its own: a way back, and the
 * address a shared link to this page is built from. A note, a profile and a
 * settings page are all reached by a link and all name themselves in the
 * address bar, so they use one bar and read the same.
 *
 * It is pinned, so a long page can be left without hunting for the way out. A
 * pinned bar is bounded by the element around it, so a page that pins a bar of
 * its own further down puts this one inside a region that ends where that bar
 * arrives: the bar then hovers over the region and is pushed up and out of
 * sight as the region ends, rather than sitting under the next bar.
 */
export function PageBar(props: {
  /** The hex of a note or a profile, or the hash of a page with no id. */
  id: string;
}) {
  return (
    <div class="sticky top-0 z-20 flex items-center gap-2 border-b border-(--line) bg-(--surface) px-3 py-2">
      <button
        class="shrink-0 rounded-2xl border border-(--line-strong) px-3 py-1 hover:bg-(--accent-soft)"
        onClick={goBackOrHome}
      >
        ← 戻る
      </button>
      <span class="truncate font-mono text-xs text-(--ink-muted)">
        {props.id}
      </span>
    </div>
  );
}
