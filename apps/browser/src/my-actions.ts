import { createSignal } from "solid-js";

/**
 * What the signed-in reader has already done to each post, so the action row
 * can say so. The state is optimistic: an action counts as done once at least
 * one relay accepted it, and it survives navigation like the feeds do.
 */
export type ActionKind = "reply" | "repost" | "quote" | "react";

const [done, setDone] = createSignal<ReadonlyMap<ActionKind, ReadonlySet<string>>>(
  new Map(),
);

function mark(kind: ActionKind, eventId: string): void {
  setDone((prev) => {
    const next = new Map(prev);
    const ids = new Set(next.get(kind) ?? []);
    if (ids.has(eventId)) return prev;
    ids.add(eventId);
    next.set(kind, ids);
    return next;
  });
}

export const markReplied = (eventId: string): void => mark("reply", eventId);
export const markReposted = (eventId: string): void => mark("repost", eventId);
export const markQuoted = (eventId: string): void => mark("quote", eventId);
export const markReacted = (eventId: string): void => mark("react", eventId);

/** True once the reader has performed the action on this post. */
export function hasDone(kind: ActionKind, eventId: string): boolean {
  return done().get(kind)?.has(eventId) === true;
}

/** Dropped on logout so another key does not inherit the highlights. */
export function resetMyActions(): void {
  setDone(new Map());
}
