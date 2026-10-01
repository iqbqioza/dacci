import { goBackOrHome } from "../router.js";

/**
 * The bar at the top of a page that has a link of its own: a way back, and the
 * address a shared link to this page is built from. A note, a profile and a
 * settings page are all reached by a link and all name themselves in the
 * address bar, so they use one bar and read the same.
 *
 * It is pinned by default, so a long page can be left without hunting for the
 * way out. A page that already pins a bar of its own further down cannot have
 * two pinned at the same edge without one covering the other, so it says
 * `sticky={false}` and lets this one scroll away instead.
 */
export function PageBar(props: {
  /** The hex of a note or a profile, or the hash of a page with no id. */
  id: string;
  sticky?: boolean;
}) {
  return (
    <div
      class="flex items-center gap-2 border-b border-(--dads-solid-gray-200) bg-white px-3 py-2"
      classList={{ "sticky top-0 z-20": props.sticky !== false }}
    >
      <button
        class="shrink-0 rounded-2xl border border-(--dads-solid-gray-300) px-3 py-1 hover:bg-(--dads-blue-50)"
        onClick={goBackOrHome}
      >
        ← 戻る
      </button>
      <span class="truncate font-mono text-xs text-(--dads-solid-gray-500)">
        {props.id}
      </span>
    </div>
  );
}
