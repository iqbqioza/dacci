import { encodeNpub } from "dacci-nostr-nips";
import { useAuth } from "../auth.jsx";
import { useFollowState } from "../my-follows.js";
import { copyItem, OverflowMenu } from "./OverflowMenu.jsx";

/**
 * A profile's own actions, on the right of the name row: the overflow menu
 * first, then the follow button. The menu comes first so the two are read in
 * the same order as on the post card, where the menu sits after the time.
 *
 * A reader cannot follow themselves, so their own profile shows no button:
 * it would be a control whose only answer is a refusal.
 */
export function ProfileActions(props: { pubkey: string }) {
  const self = useAuth().pubkey;
  const isSelf = (): boolean => self() !== null && self() === props.pubkey;

  return (
    <div class="flex items-center gap-2">
      <OverflowMenu
        label="プロフィールの操作"
        items={[
          copyItem("npub をコピー", encodeNpub(props.pubkey)),
          copyItem("pubkey をコピー", props.pubkey),
        ]}
      />
      {isSelf() ? null : <FollowButton pubkey={props.pubkey} />}
    </div>
  );
}

/**
 * NIP-02 follow, as a toggle: the second press republishes the list without the
 * person in it. There is no deletion event for a follow, because the list is
 * one replaceable event, so unfollowing is another kind 3 of its own.
 *
 * The button says nothing until the list has been read. Guessing would show
 * "フォロー" to a reader who already follows this profile, and pressing it
 * would then unfollow them instead.
 */
function FollowButton(props: { pubkey: string }) {
  const state = useFollowState(props.pubkey);
  // Pressing it before the list is known would publish a list built from an
  // empty one, which drops everyone the reader already follows.
  const disabled = (): boolean => state.following() === null || state.loading();

  return (
    <button
      type="button"
      disabled={disabled()}
      aria-pressed={state.following() === true}
      class={`min-w-24 rounded-full border px-4 py-1.5 text-sm font-medium disabled:opacity-60 ${
        state.following() === true
          ? "border-(--line) text-(--ink) hover:border-(--danger) hover:text-(--danger)"
          : "border-(--accent) bg-(--accent) text-(--on-accent) hover:opacity-90"
      }`}
      onClick={() => void state.toggle()}
    >
      {labelOf(state.following())}
    </button>
  );
}

/**
 * What the button reads. Both states name the state rather than the action, so
 * a reader who has just pressed it can see what they did without pressing it
 * again. The unknown state says so instead of guessing, because a follow list
 * that has not been read is not the same as a list without the person in it.
 */
function labelOf(following: boolean | null): string {
  if (following === null) return "読み込み中…";
  return following ? "フォロー中" : "フォロー";
}