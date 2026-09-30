import { createSignal } from "solid-js";

/** Transient confirmation for actions that have no visible result. */
const [message, setMessage] = createSignal<string | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;

export const noticeMessage = message;

export function showNotice(text: string, durationMs = 2000): void {
  setMessage(text);
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    setMessage(null);
  }, durationMs);
}

export function clearNotice(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  setMessage(null);
}
