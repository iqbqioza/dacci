/**
 * Runs `change` while holding the viewport on whatever the reader is
 * looking at. Any layout change inside - a control being added or removed,
 * posts being inserted - is absorbed, so the visible content never moves.
 *
 * `container` must be the element that holds the rendered items; the
 * anchor is the item covering the top edge of the viewport.
 */
export function preservingViewport(
  container: HTMLElement | undefined,
  change: () => void,
): void {
  const scrollBefore = window.scrollY;
  const anchor = itemUnderTopEdge(container);
  const before = anchor === null ? null : anchor.getBoundingClientRect().top;

  change();

  if (anchor === null || before === null || !anchor.isConnected) return;
  // Solid applies updates synchronously, so the DOM is already laid out
  // here. Measuring in a later frame would let unrelated reflow (lazy
  // images, a background page load) corrupt the correction.
  const after = anchor.getBoundingClientRect().top;
  const target = Math.max(scrollBefore + (after - before), 0);
  if (target !== window.scrollY) {
    window.scrollTo({ top: target, behavior: "instant" });
  }
}

/**
 * The item currently under the top edge of the viewport. It has to be the
 * one that *covers* that line: relays do carry multi-thousand-pixel
 * events, and picking the first item below the edge would anchor to
 * something the reader cannot see.
 */
export function itemUnderTopEdge(
  container: HTMLElement | undefined,
  selector = "article",
): HTMLElement | null {
  if (container === undefined) return null;
  const items = container.querySelectorAll<HTMLElement>(selector);
  if (items.length === 0) return null;
  const probeY = 8;
  for (const item of items) {
    const rect = item.getBoundingClientRect();
    if (rect.top > probeY) break;
    if (rect.bottom > probeY) return item;
  }
  for (const item of items) {
    if (item.getBoundingClientRect().bottom > 0) return item;
  }
  return items[0];
}
