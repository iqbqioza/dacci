import type { MetadataValue } from "dacci-nostr-nips";
import { birthdayFrom, buildMetadata, withMetadata } from "dacci-nostr-nips";
import { createSignal } from "solid-js";
import { useAuth } from "./auth.jsx";
import { publishEvent, publishFailureText } from "./compose.js";
import { showNotice } from "./notice.js";
import { applyProfile, requestProfiles, useProfile } from "./profile.js";

/**
 * The profile the reader is editing.
 *
 * NIP-01 keeps a whole profile in one replaceable event, so editing is not a
 * patch: the fields that are not on the form are read from the published
 * profile and written back with the ones that changed. Dropping them would
 * delete whatever another client put there.
 *
 * The editor is a module-level signal rather than state on a page, because it
 * is opened from two places: Settings, and the reader's own profile.
 */
const [open, setOpen] = createSignal(false);
const [busy, setBusy] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);

export const profileEditorOpen = open;
export const profileEditorBusy = busy;
export const profileEditorError = error;

/** Opens the editor. A signed-out reader has no profile to edit. */
export function openProfileEditor(): boolean {
  const pubkey = useAuth().pubkey();
  if (pubkey === null) {
    showNotice("プロフィールを編集するにはログインしてください");
    return false;
  }
  // The form starts from what is published, so the profile has to be asked for.
  // Settings asks for nothing else: without this the form is blank and saving
  // it would replace a real profile with an empty one.
  requestProfiles([pubkey]);
  setError(null);
  setOpen(true);
  return true;
}

export function closeProfileEditor(): void {
  setOpen(false);
  setError(null);
}

/**
 * The text fields the editor offers, in the order they read.
 *
 * NIP-01 names `name`, `about` and `picture`, and NIP-24 adds `display_name`,
 * `website` and `banner`. The last three are not in any NIP: clients read them
 * and writers set them, so a form that cannot reach them is a form that cannot
 * edit a profile other people see in full. Everything not listed here is still
 * published, so a field nobody can reach from here is not lost either.
 */
export const PROFILE_FIELDS: ReadonlyArray<{
  key: string;
  label: string;
  long: boolean;
}> = [
  { key: "display_name", label: "表示名", long: false },
  { key: "name", label: "ユーザー名", long: false },
  { key: "about", label: "自己紹介", long: true },
  { key: "nip05", label: "nip05", long: false },
  { key: "website", label: "ウェブサイト", long: false },
  { key: "email", label: "メール", long: false },
  { key: "location", label: "場所", long: false },
  { key: "lud16", label: "lud16", long: false },
];

/** The image fields, which the form fills from an upload rather than a paste. */
export const PROFILE_IMAGES: ReadonlyArray<{
  key: string;
  label: string;
}> = [
  { key: "picture", label: "アイコン" },
  { key: "banner", label: "バナー" },
];

/**
 * The changes a form's contents mean.
 *
 * Only what the reader touched is included. Sending an untouched field would
 * send it as empty, and an empty field is a removal, so a form that filled
 * itself from a profile that has not finished arriving would delete it.
 */
export function profileChanges(
  draft: Record<string, string>,
  /** `YYYY-MM-DD`, or undefined when the reader did not touch it. */
  birthday?: string,
  /** "true" or "false", or undefined when the reader did not touch it. */
  bot?: string,
): Record<string, MetadataValue> {
  const out: Record<string, MetadataValue> = {};
  for (const field of [...PROFILE_FIELDS, ...PROFILE_IMAGES]) {
    const text = draft[field.key];
    if (text !== undefined) out[field.key] = text;
  }
  if (birthday !== undefined) out.birthday = birthdayFrom(birthday);
  if (bot !== undefined) out.bot = bot === "true";
  return out;
}

/**
 * Publishes the reader's profile with some fields changed.
 *
 * What was published is put into the store before returning, so the header
 * shows the new name at once rather than after a reload. The event on the relay
 * is the profile from then on; this only decides what the reader sees now.
 */
export async function saveProfile(
  changes: Record<string, MetadataValue>,
): Promise<boolean> {
  const pubkey = useAuth().pubkey();
  if (pubkey === null) {
    setError("ログインが必要です (Settings)");
    return false;
  }
  if (busy()) return false;
  // NIP-01 replaces the whole profile, so this has to be built from the one
  // that is published. A lookup that has not answered yet is not an empty
  // profile, and publishing on top of it would wipe whatever is there.
  const entry = useProfile(pubkey);
  if (!entry.resolved) {
    setError("プロフィールを読み込んでいます");
    return false;
  }
  const current = entry.profile?.metadata ?? {};
  setBusy(true);
  setError(null);
  try {
    const sent = await publishEvent(
      buildMetadata({
        pubkey,
        metadata: withMetadata(current, changes),
        createdAt: Math.floor(Date.now() / 1000),
      }),
      // The editor shows the reason itself rather than the compose dialog's
      // line, which this never opens.
      (reason) => setError(publishFailureText(reason, "プロフィールの保存")),
    );
    if (sent === null) return false;
    applyProfile(sent);
    setOpen(false);
    showNotice("プロフィールを保存しました");
    return true;
  } finally {
    setBusy(false);
  }
}