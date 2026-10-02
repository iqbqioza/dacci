import type { NostrEvent } from "dacci-nostr-nips";
import { isComment } from "dacci-nostr-nips";

/**
 * The post a reply answers directly, as opposed to the root of the thread it
 * belongs to. A detail page shows the direct answers under the post, so the
 * distinction decides what belongs there.
 *
 * NIP-10 marks the direct parent with `reply` and the thread root with
 * `root`; a top-level reply to the root carries only `root`, so that tag is
 * the direct parent when no `reply` marker is present. The deprecated
 * positional form has no markers, and its last `e` tag is the parent. The
 * third marker, `mention`, names a post the author only refers to, so it is
 * never a parent.
 */
export function replyParent(event: NostrEvent): string | null {
  const parents = event.tags.filter((tag) => tag[0] === "e" && isHex64(tag[1]));
  if (parents.length === 0) return null;
  const marked = parents.find((tag) => tag[3] === "reply");
  if (marked !== undefined) return marked[1];
  // A lone `root` tag means the reply answers the root directly, which is
  // what NIP-10 prescribes for a top-level reply.
  const root = parents.find((tag) => tag[3] === "root");
  if (root !== undefined) return root[1];
  // Unmarked tags are the deprecated positional form: last one is the parent.
  // A `mention` marker is not that form: NIP-10 gives it to name a post the
  // author refers to rather than answers, so it never holds a parent. Left in
  // the pool it would become the parent by position, and a post that merely
  // points at another one would be listed under it as a reply.
  const positional = parents.filter((tag) => tag[3] !== "mention");
  return positional.length === 0 ? null : positional[positional.length - 1][1];
}

/**
 * The post a NIP-22 comment answers directly. A comment points at its root
 * scope with the uppercase tags and at its parent item with the lowercase
 * ones, so the lowercase `e` names the parent. Comments scoped to an address
 * or an external `i` value have no event parent and are left out.
 *
 * This only reads a genuine comment. A NIP-10 reply also carries lowercase
 * `e` tags, so accepting any `e` here would read a reply's `root` marker as
 * a parent and attach the whole thread to the top post.
 */
export function commentReplyParent(event: NostrEvent): string | null {
  if (!isComment(event)) return null;
  // NIP-22 requires the lowercase `k` tag naming the parent item's kind, and
  // the uppercase `K` for the root's. Only a comment carries both.
  const scoped = event.tags.some((tag) => tag[0] === "K" || tag[0] === "E" || tag[0] === "A");
  if (!scoped) return null;
  const parent = event.tags.find((tag) => tag[0] === "e" && isHex64(tag[1]));
  return parent === undefined ? null : parent[1];
}

function isHex64(value: string | undefined): boolean {
  return value !== undefined && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Whether a post is a direct answer to `target`, covering NIP-10 replies
 * and NIP-22 comments alike. A post that answers itself, or that only names
 * the thread root while sitting deeper in a thread, is not a direct answer.
 */
export function isDirectReply(candidate: NostrEvent, target: string): boolean {
  if (candidate.id === target) return false;
  if (candidate.kind !== 1 && !isComment(candidate)) return false;
  return (
    replyParent(candidate) === target || commentReplyParent(candidate) === target
  );
}

/**
 * The direct answers to one post, oldest first, so a conversation reads top
 * to bottom from the post it answers.
 */
export function directReplies(
  candidates: NostrEvent[],
  target: string,
): NostrEvent[] {
  return candidates
    .filter((event) => isDirectReply(event, target))
    .sort((a, b) =>
      a.created_at !== b.created_at ? a.created_at - b.created_at : a.id < b.id ? -1 : 1,
    );
}
