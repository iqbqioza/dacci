import type { NostrEvent } from "dacci-nostr-nips";
import { encodeNote, encodeNpub } from "dacci-nostr-nips";
import { createSignal } from "solid-js";
import { useAuth } from "../auth.jsx";
import { broadcastEvent, deleteEvent } from "../compose.js";
import { isOwn } from "../deleted.js";
import { useMuteState } from "../muted.js";
import { Confirm } from "./Confirm.jsx";
import { copyItem, OverflowMenu, type MenuEntry } from "./OverflowMenu.jsx";

/**
 * Per-post overflow menu. Placed at the far right of the card header, so it
 * must not open the post itself.
 *
 * The rows are what a post is made of: its own address, the author's key, and
 * the event as it was signed, so it can be verified or re-published elsewhere.
 * Two rows act on the network rather than on the text, and they are the
 * mirror image of each other: muting is offered for anyone else's post, since
 * that is how a reader meets a name they do not want to see again, while
 * deleting is offered only for their own, because it is the one that cannot be
 * undone.
 */
export function PostMenu(props: {
  event: NostrEvent;
  onOpen: (event: NostrEvent) => void;
}) {
  const self = useAuth().pubkey;
  // Whether this is the reader's own post, which decides two rows and no
  // others: a deletion request naming someone else's post is not a deletion,
  // and there is nothing of their own to mute.
  const mine = (): boolean => isOwn(props.event, self());
  const mute = useMuteState(props.event.pubkey);
  const [asking, setAsking] = createSignal(false);

  const rows = (): MenuEntry[] => [
    {
      label: "詳細を開く",
      run: () => {
        props.onOpen(props.event);
        return null;
      },
    },
    {
      // The one row that is offered on every post, whatever wrote it: sending
      // an event as it stands needs no authority over it. The outcome is
      // reported by the action itself, which knows how many relays took it,
      // so the menu does not add a second line saying less.
      label: "自分のリレーに再配信",
      run: async () => {
        await broadcastEvent(props.event);
        return null;
      },
    },
    // Muting is offered on someone else's post and not on the reader's own,
    // because a reader meets a name they do not want to see again in a feed
    // rather than on their own profile, and there is nothing of their own to
    // mute. The two rows below are the mirror image: they act on the reader's
    // own post, and only on it.
    ...(mine()
      ? []
      : [
          {
            label: mute.muted() === true ? "ミュートを解除" : "ミュート",
            run: async () => {
              await mute.toggle();
              return null;
            },
          },
        ]),
    copyItem("npub をコピー", encodeNpub(props.event.pubkey)),
    copyItem("note ID をコピー", encodeNote(props.event.id)),
    copyItem("JSON をコピー", JSON.stringify(props.event)),
    ...(mine()
      ? [
          {
            label: "削除",
            danger: true,
            // The menu closes first and the question opens over the page, so a
            // reader who meant to dismiss the menu is not asked about
            // something they did not choose.
            run: () => {
              setAsking(true);
              return null;
            },
          },
        ]
      : []),
  ];

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