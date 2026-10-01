import type { NostrEvent } from "dacci-nostr-nips";
import { encodeNote, encodeNpub } from "dacci-nostr-nips";
import { createSignal } from "solid-js";
import { useAuth } from "../auth.jsx";
import { deleteEvent } from "../compose.js";
import { isOwn } from "../deleted.js";
import { Confirm } from "./Confirm.jsx";
import { copyItem, OverflowMenu, type MenuEntry } from "./OverflowMenu.jsx";

/**
 * Per-post overflow menu. Placed at the far right of the card header, so it
 * must not open the post itself.
 *
 * The rows are what a post is made of: its own address, the author's key, and
 * the event as it was signed, so it can be verified or re-published elsewhere.
 * On the reader's own post one more row appears, which is the only one here
 * that cannot be undone.
 */
export function PostMenu(props: {
  event: NostrEvent;
  onOpen: (event: NostrEvent) => void;
}) {
  const self = useAuth().pubkey;
  // A deletion request for someone else's post is not a deletion, so the row
  // is only offered where it would actually do something.
  const mine = (): boolean => isOwn(props.event, self());
  const [asking, setAsking] = createSignal(false);

  const rows = (): MenuEntry[] => [
    {
      label: "詳細を開く",
      run: () => {
        props.onOpen(props.event);
        return null;
      },
    },
    copyItem("npub をコピー", encodeNpub(props.event.pubkey)),
    copyItem("note ID をコピー", encodeNote(props.event.id)),
    copyItem("JSON をコピー", JSON.stringify(props.event)),
    {
      label: "削除",
      danger: true,
      // The menu closes first and the question opens over the page, so a
      // reader who meant to dismiss the menu is not asked about something
      // they did not choose.
      run: () => {
        setAsking(true);
        return null;
      },
    },
  ].filter((item) => item.label !== "削除" || mine());

  return (
    <>
      <OverflowMenu label="投稿の操作" items={rows()} />
      <Confirm
        open={asking()}
        title="投稿を削除しますか？"
        body="NIP-09 の削除要求を公開します。従うリレーでは、この投稿はもう配信されません。"
        confirmLabel="削除する"
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          void deleteEvent(props.event);
        }}
      />
    </>
  );
}