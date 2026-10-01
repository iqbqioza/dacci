import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Icon } from "./Icon.jsx";
import {
  addServerAndPublish,
  removeServerAndPublish,
  useUploadServers,
  type UploadServer,
} from "../servers.js";
import {
  isUploadableFile,
  uploadFailureText,
  uploadFile,
  type UploadFailure,
} from "../upload.js";

const EDIT_ERROR: Record<"invalid" | "duplicate", string> = {
  invalid: "https:// で始まるURLを入力してください",
  duplicate: "このサーバーはすでに登録されています",
};

/**
 * The upload button and the server picker. Picking a server asks for a file
 * and puts the returned url at the caret, so the reader can add their own
 * words around it instead of only appending a link.
 */
export function UploadPicker(props: {
  /** Called with the url to insert, or null when the upload failed. */
  onUploaded: (url: string) => void;
  onError: (message: string) => void;
  /** Signed-in readers can sign the request a server expects. */
  canUpload: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [adding, setAdding] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [addError, setAddError] = createSignal<string | null>(null);
  /** True while the list is being published, so a double press cannot. */
  const [saving, setSaving] = createSignal(false);
  /** Where the list sits, as an offset from the icon it belongs to. */
  const [at, setAt] = createSignal({ x: 0, y: 0 });
  const { all } = useUploadServers();
  // The picker is a popup: a click anywhere else, or Escape, closes it.
  let root: HTMLDivElement | undefined;
  // Solid calls a ref it is given, so this has to be a callback that keeps
  // the element rather than a getter: a getter would be invoked with no
  // argument and the input would never be found.
  let input: HTMLInputElement | undefined;

  const onDocumentClick = (event: MouseEvent): void => {
    if (open() && root !== undefined && !root.contains(event.target as Node)) {
      setOpen(false);
    }
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") setOpen(false);
  };
  if (typeof document !== "undefined") {
    document.addEventListener("click", onDocumentClick);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onKey);
    });
  }

  // The list sits beside the icon rather than over it, so the button the
  // reader aimed at stays visible and can be pressed again to dismiss, and it
  // is centred on the icon in the other direction. A window too narrow for
  // either side puts it under the icon, and one too short for its height lets
  // it scroll instead of running off the top: a reply form sits near the top
  // of a note's page, where a list that always opened upwards left the screen.
  createEffect(() => {
    if (!open() || root === undefined) return;
    const list = root.querySelector<HTMLElement>("[data-list]");
    if (list === null) return;
    const icon = root.getBoundingClientRect();
    // The layout size, not the painted one: a transform moves the list without
    // changing it, and measuring the moved box would move it further.
    const width = list.offsetWidth;
    const height = list.offsetHeight;
    const margin = 8;
    const gap = 6;
    const fits = (left: number): boolean =>
      left >= margin && left + width <= window.innerWidth - margin;
    const right = icon.right + gap;
    const left = icon.left - gap - width;
    // A window narrower than the list has neither side, so it goes under the
    // icon rather than over it: covering the button would leave no way to
    // dismiss it but by pressing the list itself.
    const beside = fits(right) ? "right" : fits(left) ? "left" : "below";
    // The list is placed with a transform, which is measured from the icon's
    // own corner, while the room it has to fit in is the whole window. So the
    // place in the window becomes a distance from the icon.
    const x =
      beside === "right"
        ? right
        : beside === "left"
          ? left
          : keepInside(icon.left, width, window.innerWidth);
    const centred = icon.top + icon.height / 2 - height / 2;
    const y =
      beside === "below"
        ? keepInside(icon.bottom + gap, height, window.innerHeight)
        : keepInside(centred, height, window.innerHeight);
    setAt({ x: x - icon.left, y: y - icon.top });

    /** The place a box of this size takes, kept clear of the window's edges. */
    function keepInside(wanted: number, size: number, limit: number): number {
      const room = limit - size - margin;
      // A box taller than the window has no centred place, so it starts at
      // the top margin and scrolls rather than running off the bottom.
      return wanted < margin ? margin : wanted > room ? Math.max(margin, room) : wanted;
    }
  });

  async function uploadTo(server: UploadServer, file: File): Promise<void> {
    setOpen(false);
    setBusy(server.url);
    try {
      const result = await uploadFile(server, file);
      if ("failure" in result) {
        props.onError(failureMessage(result.failure, result.message));
        return;
      }
      props.onUploaded(result.url);
    } finally {
      setBusy(null);
    }
  }

  /** Clicking a server remembers it, then opens the file dialog. */
  function pick(server: UploadServer): void {
    if (input === undefined) return;
    const el = input;
    // The same input serves every server, so it is re-armed each time; a
    // second pick of the same file would otherwise not fire a change.
    el.value = "";
    // The handler is bound here rather than in the markup, because the
    // server it belongs to is only known once one is clicked. It is bound
    // before the dialog opens, so a file chosen quickly is not missed.
    el.onchange = () => {
      const file = el.files?.[0];
      if (file === undefined) return;
      if (!isUploadableFile(file)) {
        props.onError("空のファイルはアップロードできません");
        return;
      }
      void uploadTo(server, file);
    };
    el.click();
  }

  async function add(): Promise<void> {
    if (!adding() || saving()) return;
    setSaving(true);
    setAddError(null);
    try {
      // The list is published as the account's own event, so the reader does
      // not have to set the same servers again on another client.
      const result = await addServerAndPublish(draft());
      if (result !== "ok") {
        setAddError(EDIT_ERROR[result]);
        return;
      }
      setDraft("");
      setAdding(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      ref={(el) => {
        root = el;
      }}
      class="relative"
    >
      <button
        type="button"
        class="flex size-8 items-center justify-center rounded-full text-(--ink-muted) hover:bg-(--fill-soft) hover:text-(--accent)"
        aria-label="画像をアップロード"
        aria-expanded={open()}
        title="画像をアップロード"
        disabled={!props.canUpload}
        onClick={() => setOpen(!open())}
      >
        <Show
          when={busy() === null}
          fallback={<span class="text-xs">送信中…</span>}
        >
          <Icon name="photo" class="size-5" />
        </Show>
      </button>

      <Show when={open()}>
        <div
          data-list
          class="absolute top-0 left-0 z-30 max-h-[calc(100dvh-1rem)] w-72 overflow-y-auto overscroll-contain rounded-2xl border border-(--line) bg-(--surface) p-1 shadow-lg"
          style={{ transform: `translate(${at().x}px, ${at().y}px)` }}
        >
          <p class="px-3 pt-2 pb-1 text-xs font-bold text-(--ink-quiet)">
            Media upload(Blossom)
          </p>
          <ServerList
            servers={all()}
            onPick={pick}
            onRemove={(url) => void removeServerAndPublish(url)}
          />
          <AddRow
            label="+ Blossom サーバーを追加"
            active={adding()}
            onToggle={() => {
              setAdding(!adding());
              setAddError(null);
              setDraft("");
            }}
            draft={draft()}
            error={addError()}
            saving={saving()}
            placeholder="https://blossom.example"
            onDraft={setDraft}
            onAdd={() => void add()}
          />
        </div>
      </Show>

      {/* One input for the whole picker: whichever server was clicked is
          remembered by the change handler, so the dialog appears once. */}
      <input
        ref={(el) => {
          input = el;
        }}
        type="file"
        class="hidden"
      />
    </div>
  );
}

function failureMessage(failure: UploadFailure, detail?: string): string {
  return detail !== undefined && detail !== ""
    ? detail
    : uploadFailureText(failure);
}

function ServerList(props: {
  servers: UploadServer[];
  onPick: (server: UploadServer) => void;
  onRemove: (url: string) => void;
}) {
  return (
    <Show
      when={props.servers.length > 0}
      fallback={
        <p class="px-3 py-1 text-xs text-(--ink-muted)">
          サーバーが登録されていません
        </p>
      }
    >
      <ul>
        <For each={props.servers}>
          {(server) => (
            <li class="flex items-center gap-1">
              <button
                type="button"
                class="min-w-0 flex-1 truncate rounded-2xl px-3 py-1.5 text-left text-sm hover:bg-(--accent-soft)"
                title={`${server.url} にアップロード`}
                onClick={() => props.onPick(server)}
              >
                {server.url}
              </button>
              {/* The servers the app offers itself are not the reader's to
                  remove, so the button is not offered for them at all. */}
              <Show when={server.builtin !== true}>
                <button
                  type="button"
                  class="shrink-0 rounded-full px-2 py-1 text-xs text-(--ink-muted) hover:bg-(--line) hover:text-(--danger)"
                  title="このサーバーを削除"
                  onClick={() => props.onRemove(server.url)}
                >
                  削除
                </button>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

function AddRow(props: {
  label: string;
  active: boolean;
  placeholder: string;
  draft: string;
  error: string | null;
  saving: boolean;
  onToggle: () => void;
  onDraft: (value: string) => void;
  onAdd: () => void;
}) {
  return (
    <div class="border-t border-(--line)">
      <button
        type="button"
        class="w-full rounded-2xl px-3 py-1.5 text-left text-sm text-(--accent) hover:bg-(--accent-soft)"
        onClick={props.onToggle}
      >
        {props.label}
      </button>
      <Show when={props.active}>
        <div class="px-2 pb-2">
          <div class="flex gap-1">
            <input
              class="min-w-0 flex-1 rounded-2xl border border-(--line-strong) px-2 py-1 text-sm"
              placeholder={props.placeholder}
              value={props.draft}
              disabled={props.saving}
              onInput={(e) => props.onDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") props.onAdd();
              }}
            />
            <button
              type="button"
              class="rounded-2xl bg-(--accent) px-3 py-1 text-sm text-(--on-accent) disabled:opacity-50"
              disabled={props.draft.trim() === "" || props.saving}
              onClick={props.onAdd}
            >
              {props.saving ? "保存中…" : "追加"}
            </button>
          </div>
          <Show when={props.error}>
            {(message) => (
              <p class="mt-1 px-1 text-xs text-(--danger)">{message()}</p>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}
