import type { NostrEvent } from "dacci-nostr-nips";
import { encodeNpub } from "dacci-nostr-nips";
import { Show, createEffect, createMemo } from "solid-js";
import { requestEmbeds } from "../embeds.js";
import { isQuoteRepost, showsCommentLabel, showsRepostLabel } from "../feed-tabs.jsx";
import { carriesInlineEvent } from "../embeds.js";
import { formatTime } from "../nostr.js";
import { navigate, profileHash } from "../router.js";
import { ActionBar } from "./ActionBar.jsx";
import { EmbeddedCard, EmbeddedPlaceholder } from "./EmbeddedCard.jsx";
import { NoteBody } from "./NoteBody.jsx";
import { ProfileAvatar, ProfileName } from "./ProfileAvatar.jsx";
import { PostMenu } from "./PostMenu.jsx";
import { SensitiveBody } from "./SensitiveBody.jsx";

/**
 * Every post in the app uses this card: the author's icon in the left column
 * and the post in the right column, so timelines, notifications and a note's
 * own page read the same way. The header carries the name with its npub
 * underneath, the time and the overflow menu on the right.
 *
 * A feed clips nothing, because a post is one of many. A detail page is the
 * only view of that post, so `detailed` drops the hover affordances and lets
 * the text use the full width: a long note is what the reader came for.
 */
export function EventCard(props: {
  event: NostrEvent;
  onSelect: (event: NostrEvent) => void;
  /** The post's own page: no hover styling, wider text, no hover cursor. */
  detailed?: boolean;
}) {
  const npub = createMemo(() => encodeNpub(props.event.pubkey));

  // A repost or a quote repost shows the note it points at. The store
  // coalesces every card on screen into one batched query.
  createEffect(() => {
    requestEmbeds([props.event]);
  });

  // A feed separates its entries with a rule. A detail page keeps it too: the
  // post is followed by the replies heading, and its own rule is what closes
  // the post before that heading opens the conversation.
  const surface = (): string =>
    props.detailed === true
      ? "flex gap-3 border-b border-(--line) px-4 py-4"
      : "flex cursor-pointer gap-3 border-b border-(--line) px-4 py-3 hover:bg-(--accent-soft)";

  return (
    <article
      class={surface()}
      // Keyboard-reachable, so pressing Enter on the card does what clicking it
      // does. The card is not given `role="link"`: a post's body carries links
      // of its own, and a link inside a link is worse than no role at all. The
      // overflow menu's "詳細を開く" remains the labelled route to the same page,
      // which is what a screen reader is told about.
      //
      // Focusable on its own page too, even though Enter does nothing there. A
      // dialog opened out of this card hands focus back to it on dismissal, and
      // `focus()` on an element with no tabindex is a silent no-op — so without
      // this, cancelling the delete question on a post's own page dropped a
      // screen reader at the top of the document.
      tabIndex={0}
      // Named, because it is in the tab order and nothing said what it was for.
      // The accessibility tree reported every card as an `article` with an empty
      // name, so a reader moving through the feed by keyboard heard a list of
      // unlabelled articles and had to work out from the controls inside each one
      // that the whole thing went somewhere.
      //
      // A name and not a role: `role="link"` would nest the body's own links,
      // which is what the comment above is about. What the name cannot do is say
      // that the card is activatable — that is what the overflow menu's
      // "詳細を開く" is for, and it names the same destination.
      aria-label="投稿を開く"
      onClick={() => {
        // On its own page the post is already open, so clicking must not
        // navigate to the very same route.
        if (props.detailed !== true) props.onSelect(props.event);
      }}
      onKeyDown={(e) => {
        if (props.detailed === true) return;
        // Only when the card itself has focus. The key event of a button inside
        // it bubbles here too, and answering that would open the post as well as
        // do whatever the button was pressed for.
        if (e.target !== e.currentTarget) return;
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        props.onSelect(props.event);
      }}
    >
      <ProfileAvatar pubkey={props.event.pubkey} />
      <div class="min-w-0 flex-1">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <button
              class="block max-w-full text-left hover:underline"
              title="プロフィールを開く"
              onClick={(e) => {
                // Opening the profile must not open the post as well.
                e.stopPropagation();
                navigate(profileHash(props.event.pubkey));
              }}
            >
              <ProfileName pubkey={props.event.pubkey} />
            </button>
            <p
              class="truncate font-mono text-xs text-(--ink-muted)"
              title={npub() ?? props.event.pubkey}
            >
              {npub() ?? props.event.pubkey}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            {/* A post that answers another one is labelled コメント, and a
                repost リポスト, so a conversation is told apart from a
                standalone note and from something the account merely passed on.
                Without the second label a repost read as an empty note, since
                that is exactly what its own content is. */}
            <Show when={showsCommentLabel(props.event)}>
              <span class="rounded-md bg-(--fill-soft) px-1.5 py-0.5 text-xs text-(--ink-quiet)">
                コメント
              </span>
            </Show>
            <Show when={showsRepostLabel(props.event)}>
              <span class="rounded-md bg-(--fill-soft) px-1.5 py-0.5 text-xs text-(--ink-quiet)">
                {isQuoteRepost(props.event) ? "引用リポスト" : "リポスト"}
              </span>
            </Show>
            <span class="text-xs whitespace-nowrap text-(--ink-muted)">
              {formatTime(props.event.created_at)}
            </span>
            <PostMenu event={props.event} onOpen={props.onSelect} />
          </div>
        </div>
        {/* The note shown as an embed below replaces its `nostr:` link, so
            the text drops that link rather than printing it twice. A feed
            never clips it either: a long note is the reader's whole reason
            for opening the post. A post that carries a NIP-36 warning is
            covered until the reader acts on it, embeds included: a quoted
            note is someone else's post and carries its own warning. */}
        <SensitiveBody event={props.event}>
          {/* A repost whose content *is* the reposted event has no text of its
              own to print: NIP-18 puts the note there as JSON, and drawing it
              would print a wall of escaped braces above the note itself. The
              embed below is the whole of it. A quote repost keeps its own words
              in the content, and those are drawn. */}
          <Show when={!carriesInlineEvent(props.event)}>
            <p class="whitespace-pre-wrap break-words text-(--ink)">
              <NoteBody event={props.event} />
            </p>
          </Show>
          <EmbeddedCard event={props.event} onSelect={props.onSelect} />
          <EmbeddedPlaceholder event={props.event} />
        </SensitiveBody>
        <ActionBar event={props.event} />
      </div>
    </article>
  );
}
