import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { MetadataValue } from "dacci-nostr-nips";
import { birthdayTo } from "dacci-nostr-nips";
import { useAuth } from "../auth.jsx";
import {
  closeProfileEditor,
  PROFILE_FIELDS,
  PROFILE_IMAGES,
  profileChanges,
  profileEditorBusy,
  profileEditorError,
  profileEditorOpen,
  saveProfile,
} from "../profile-edit.js";
import { useProfile } from "../profile.js";
import { UploadPicker } from "./UploadPicker.jsx";

/**
 * The profile editor: a form over the reader's own NIP-01 metadata, in the same
 * shape as the compose dialog so there is one modal in the app rather than two
 * idioms.
 *
 * What the form does not show is still published. NIP-01 replaces the whole
 * profile, so the fields this app has no box for are read from the published
 * event and written back untouched; only a field cleared here is removed.
 */
export function ProfileEditor() {
  const pubkey = useAuth().pubkey;
  // The published profile is the starting point, so reopening the editor shows
  // what is on the relay rather than what was typed last time.
  const published = () => useProfile(pubkey() ?? "").profile?.metadata ?? {};
  // A lookup that has not answered is not an empty profile, so the form says it
  // is still loading rather than showing empty boxes that would wipe what is
  // published.
  const resolved = () => useProfile(pubkey() ?? "").resolved;
  const [draft, setDraft] = createSignal<Record<string, string>>({});
  // NIP-24's two fields are not text: `birthday` is an object and `bot` a
  // boolean, so they are held apart rather than squeezed into a string.
  const [birthday, setBirthday] = createSignal<string | undefined>(undefined);
  const [bot, setBot] = createSignal<string | undefined>(undefined);
  const [uploadError, setUploadError] = createSignal<string | null>(null);

  const valueOf = (key: string): string => {
    const typed = draft()[key];
    if (typed !== undefined) return typed;
    const held = published()[key];
    return typeof held === "string" ? held : "";
  };

  const type = (key: string, text: string): void => {
    setDraft((prev) => ({ ...prev, [key]: text }));
  };

  const changes = (): Record<string, MetadataValue> =>
    profileChanges(draft(), birthday(), bot());

  const onUploaded = (key: string) => (url: string): void => {
    type(key, url);
    setUploadError(null);
  };

  const onUploadError = (message: string): void => {
    setUploadError(message);
  };

  /** The first field, so opening the editor can put the caret inside it. */
  let firstField: HTMLInputElement | HTMLTextAreaElement | undefined;

  // Escape is the way out of anything that asks, and the scrim already closes
  // this, so the keyboard offers nothing new that a click does not.
  createEffect(() => {
    if (!profileEditorOpen()) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeProfileEditor();
    };
    document.addEventListener("keydown", onKey);
    // This is the worst case in the app for focus: a dozen fields sit behind the
    // scrim, so a Tab left where the reader was walks the page being covered
    // rather than the form. The first field is where the caret belongs, and
    // closing hands focus back to whatever opened the editor.
    const before = document.activeElement;
    queueMicrotask(() => {
      firstField?.focus();
    });
    onCleanup(() => {
      document.removeEventListener("keydown", onKey);
      if (
        before instanceof HTMLElement &&
        before !== document.body &&
        before.isConnected
      ) {
        before.focus();
        return;
      }
      // The trigger is usually gone. The editor is mounted at the app's top level
      // and outlives the route behind it, so a change of route while it is open —
      // the browser's own Back, which works with a dialog up — takes the button
      // that opened it out of the page. `focus()` on a detached element is a
      // silent no-op, so without this the reader was left with focus on the body
      // and their next Tab restarted at the top of the document.
      //
      // The page itself is then the right place: they asked to be somewhere else,
      // and that somewhere else is where they now are. `tabindex="-1"` keeps it
      // out of the tab order and only makes it reachable on purpose.
      const main = document.querySelector<HTMLElement>("main");
      if (main === null) return;
      if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
      main.focus();
    });
  });

  return (
    <Show when={profileEditorOpen()}>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-(--scrim)"
        onClick={closeProfileEditor}
      >
        <div
          class="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-2xl bg-(--surface) p-4"
          role="dialog"
          aria-modal="true"
          aria-label="プロフィールを編集"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 class="font-bold">プロフィールを編集</h2>
          <p class="mt-1 text-xs text-(--ink-muted)">
            NIP-01 のメタデータ (kind 0) として公開されます。空にした項目は削除されます。
          </p>

          <Show when={!resolved()}>
            <p class="mt-3 text-sm text-(--ink-muted)">
              プロフィールを読み込んでいます…
            </p>
          </Show>

          <div class="mt-3 grid gap-3">
            <For each={PROFILE_FIELDS}>
              {(field, index) => (
                <label class="block">
                  <span class="text-xs text-(--ink-muted)">{field.label}</span>
                  {field.long ? (
                    <textarea
                      // Solid calls a ref it is given, so this has to be a
                      // callback that keeps the element rather than a getter.
                      ref={
                        index() === 0
                          ? (el) => {
                              firstField = el as HTMLTextAreaElement | undefined;
                            }
                          : undefined
                      }
                      class={`mt-1 w-full rounded-2xl border border-(--line-strong) p-2 text-sm ${
                        field.key === "about" ? "h-24" : "h-10"
                      }`}
                      value={valueOf(field.key)}
                      onInput={(e) => type(field.key, e.currentTarget.value)}
                    />
                  ) : (
                    <input
                      ref={
                        index() === 0
                          ? (el) => {
                              firstField = el as HTMLInputElement | undefined;
                            }
                          : undefined
                      }
                      class="mt-1 w-full rounded-2xl border border-(--line-strong) px-3 py-2 text-sm"
                      value={valueOf(field.key)}
                      onInput={(e) => type(field.key, e.currentTarget.value)}
                    />
                  )}
                </label>
              )}
            </For>
          </div>

          {/* An image is a url, and the only way this app makes one is by
              uploading it, so these two rows upload rather than take a paste.
              Both the uploaded url and a pasted one are accepted: the field is
              an input like the others, with an upload button beside it. */}
          <div class="mt-3 grid gap-3">
            <For each={PROFILE_IMAGES}>
              {(field) => (
                <div>
                  <span class="text-xs text-(--ink-muted)">{field.label}</span>
                  <div class="mt-1 flex items-center gap-2">
                    <input
                      class="min-w-0 flex-1 rounded-2xl border border-(--line-strong) px-3 py-2 text-sm"
                      placeholder="https://…"
                      value={valueOf(field.key)}
                      onInput={(e) => type(field.key, e.currentTarget.value)}
                    />
                    <UploadPicker
                      label={`${field.label}をアップロード`}
                      canUpload={pubkey() !== null}
                      onUploaded={onUploaded(field.key)}
                      onError={onUploadError}
                    />
                  </div>
                </div>
              )}
            </For>
          </div>

          {/* NIP-24's two non-text fields. `bot` says the content is from
              automation, which clients filter on, and `birthday` is an object
              rather than a string, so it gets a date input and is read back
              into the shape the NIP names. */}
          <div class="mt-3 grid gap-3">
            <label class="block">
              <span class="text-xs text-(--ink-muted)">生年月日</span>
              <input
                type="date"
                class="mt-1 w-full rounded-2xl border border-(--line-strong) px-3 py-2 text-sm"
                value={
                  birthday() ?? birthdayTo(published().birthday)
                }
                onInput={(e) => setBirthday(e.currentTarget.value)}
              />
            </label>
            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={(bot() ?? String(published().bot === true)) === "true"}
                onChange={(e) => setBot(String(e.currentTarget.checked))}
              />
              <span>自動投稿 (ボット) です</span>
            </label>
          </div>

          <Show when={uploadError()}>
            {(message) => (
              <p class="mt-2 text-sm text-(--danger)">{message()}</p>
            )}
          </Show>
          <Show when={profileEditorError()}>
            {(message) => (
              <p class="mt-2 text-sm text-(--danger)">{message()}</p>
            )}
          </Show>

          <div class="mt-4 flex justify-end gap-2">
            <button
              type="button"
              class="rounded-2xl border border-(--line-strong) px-4 py-2"
              onClick={closeProfileEditor}
            >
              やめる
            </button>
            <button
              type="button"
              class="rounded-2xl bg-(--accent) px-4 py-2 text-(--on-accent) disabled:opacity-50"
              disabled={profileEditorBusy() || pubkey() === null || !resolved()}
              onClick={() => void saveProfile(changes())}
            >
              {profileEditorBusy() ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}