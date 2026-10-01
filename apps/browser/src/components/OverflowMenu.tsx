import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { copyText } from "../clipboard.js";

/**
 * The `…` menu shared by the post card and the profile header: a button that
 * opens a small list of actions and a transient line confirming a copy.
 *
 * It is one component because the two menus must behave the same way: both
 * sit inside something the reader can click, so both have to stop the click
 * and both have to close when the reader clicks anywhere else or presses
 * Escape. Duplicating that would let the two drift apart.
 */
/** One row of an overflow menu. */
export interface MenuEntry {
  label: string;
  /**
   * What the row does. A string is shown as a transient confirmation, which is
   * what a copy reports; `null` means the row had nothing to report.
   */
  run: () => string | null | Promise<string | null>;
  /**
   * The row takes something away. It is marked in the danger colour rather
   * than separated by a rule, because a row that cannot be undone should not
   * read like the copies above it.
   */
  danger?: boolean;
}

export function OverflowMenu(props: {
  /** For the button's accessible name, e.g. "投稿の操作". */
  label: string;
  /** One entry per row, in the order they should read. */
  items: MenuEntry[];
}) {
  const [open, setOpen] = createSignal(false);
  const [notice, setNotice] = createSignal<string | null>(null);
  let root: HTMLDivElement | undefined;

  // Close on an outside click or Escape, so the menu never traps the page.
  createEffect(() => {
    if (!open()) return;
    const onPointer = (event: MouseEvent): void => {
      if (root?.contains(event.target as Node) === true) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    });
  });

  async function select(item: MenuEntry): Promise<void> {
    setOpen(false);
    const said = await item.run();
    if (said === null) return;
    setNotice(said);
    // The confirmation is transient; a stuck toast would cover the feed.
    setTimeout(() => setNotice(null), 2000);
  }

  return (
    <div ref={root} class="relative shrink-0">
      <button
        type="button"
        aria-label={props.label}
        aria-expanded={open()}
        class="rounded-full px-2 py-0.5 text-(--ink-muted) hover:bg-(--line) hover:text-(--ink)"
        onClick={(e) => {
          // The card and the header row are both clickable; the menu is not.
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        …
      </button>
      <Show when={open()}>
        {/* Above the pinned tab row of a feed or a profile, which sits at
            z-30 and would otherwise cover the rows nearest the button: the
            menu hangs down from a header that is directly above that row. */}
        <div class="absolute top-full right-0 z-40 mt-1 w-52 rounded-2xl border border-(--line) bg-(--surface) py-1 shadow-lg">
          <For each={props.items}>
            {(item) => (
              <button
                type="button"
                class={`block w-full px-4 py-2 text-left text-sm ${
                  item.danger === true
                    ? "text-(--danger) hover:bg-(--danger-soft)"
                    : "hover:bg-(--accent-soft)"
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  void select(item);
                }}
              >
                {item.label}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={notice()}>
        <span class="absolute top-full right-0 z-40 mt-1 w-max rounded-2xl bg-(--chip) px-3 py-1 text-xs whitespace-nowrap text-(--on-chip)">
          {notice()}
        </span>
      </Show>
    </div>
  );
}

/**
 * A row that copies something and reports whether it worked. The row and the
 * confirmation say different things: the row is what the reader chooses
 * ("npub をコピー") and the confirmation names what was taken ("npub を
 * コピーしました"), which reads wrong if they are the same string.
 */
export function copyItem(
  label: string,
  value: string | null,
  /** What to call the copied thing, defaulting to the row's own name. */
  report = label.replace(/ をコピー$/, ""),
): MenuEntry {
  return {
    label,
    run: async () =>
      value !== null && (await copyText(value))
        ? `${report}をコピーしました`
        : "コピーできませんでした",
  };
}