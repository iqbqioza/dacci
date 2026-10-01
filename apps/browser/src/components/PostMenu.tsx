import type { NostrEvent } from "dacci-nostr-nips";
import { encodeNote, encodeNpub } from "dacci-nostr-nips";
import { copyItem, OverflowMenu } from "./OverflowMenu.jsx";

/**
 * Per-post overflow menu. Placed at the far right of the card header, so it
 * must not open the post itself.
 *
 * The rows are what a post is made of: its own address, the author's key, and
 * the event as it was signed, so it can be verified or re-published elsewhere.
 */
export function PostMenu(props: {
  event: NostrEvent;
  onOpen: (event: NostrEvent) => void;
}) {
  return (
    <OverflowMenu
      label="投稿の操作"
      items={[
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
      ]}
    />
  );
}