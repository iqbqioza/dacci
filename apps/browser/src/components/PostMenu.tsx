import type { NostrEvent } from "dacci-nostr-nips";
import { encodeNote, encodeNpub } from "dacci-nostr-nips";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { copyText } from "../clipboard.js";

/**
 * Per-post overflow menu. Placed at the far right of the card header, so it
 * must not open the post itself.
 */
export function PostMenu(props: {
  event: NostrEvent;
  onOpen: (event: NostrEvent) => void;
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

  async function copy(label: string, value: string | null): Promise<void> {
    setOpen(false);
    const copied = value !== null && (await copyText(value));
    setNotice(copied ? `${label}をコピーしました` : "コピーできませんでした");
    // The confirmation is transient; a stuck toast would cover the feed.
    setTimeout(() => setNotice(null), 2000);
  }

  return (
    <div ref={root} class="relative shrink-0">
      <button
        type="button"
        aria-label="投稿の操作"
        aria-expanded={open()}
        class="rounded-full px-2 py-0.5 text-(--dads-solid-gray-500) hover:bg-(--dads-solid-gray-200) hover:text-(--dads-solid-gray-900)"
        onClick={(e) => {
          // The whole card is clickable; the menu is not.
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        …
      </button>
      <Show when={open()}>
        <div class="absolute top-full right-0 z-20 mt-1 w-52 rounded-2xl border border-(--dads-solid-gray-200) bg-white py-1 shadow-lg">
          <MenuItem
            label="詳細を開く"
            onSelect={() => {
              setOpen(false);
              props.onOpen(props.event);
            }}
          />
          <MenuItem
            label="npub をコピー"
            onSelect={() => void copy("npub", encodeNpub(props.event.pubkey))}
          />
          <MenuItem
            label="note ID をコピー"
            onSelect={() => void copy("note ID", encodeNote(props.event.id))}
          />
          <MenuItem
            label="イベントの JSON をコピー"
            onSelect={() => void copy("JSON", JSON.stringify(props.event))}
          />
        </div>
      </Show>
      <Show when={notice()}>
        <span class="absolute top-full right-0 z-20 mt-1 w-max rounded-2xl bg-(--dads-solid-gray-800) px-3 py-1 text-xs whitespace-nowrap text-white">
          {notice()}
        </span>
      </Show>
    </div>
  );
}

function MenuItem(props: { label: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      class="block w-full px-4 py-2 text-left text-sm hover:bg-(--dads-blue-50)"
      onClick={(e) => {
        e.stopPropagation();
        props.onSelect();
      }}
    >
      {props.label}
    </button>
  );
}
