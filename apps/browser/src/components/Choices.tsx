import { For, Show } from "solid-js";

/**
 * The inline style a swatch is painted with.
 *
 * `background`, not `background-color`: a swatch may be a gradient as well as a
 * colour, and `background-color` only accepts a colour. A gradient handed to it is
 * discarded whole by the CSS parser — it does not fall back to the other half — so
 * the system theme's swatch drew as an empty outlined pill, on a screen whose
 * stated purpose is that the choice can be judged from the row rather than by
 * pressing it. The shorthand takes both.
 *
 * Exported so a test can check every swatch against the property it is really
 * given, which is the only place this is decided: the parser, not the types.
 */
export function swatchStyle(value: string): string {
  return `background: ${value}`;
}

/**
 * A setting with a few fixed answers, as one group of buttons rather than a
 * switch: `system` beside light and dark, or `show` beside blur and hide, are
 * all real answers and none of them is the absence of one. `aria-pressed`
 * carries the choice, so the group is read as what it is instead of as three
 * unrelated buttons.
 *
 * A swatch is there when the answer can be seen: a theme shows the two it
 * resolves to, and a covering shows what it covers.
 */
export function Choices<T extends string>(props: {
  /** What the group is about, for anyone who cannot see the buttons. */
  label: string;
  options: Array<{ id: T; label: string; swatch?: string }>;
  value: () => T;
  onSelect: (next: T) => void;
}) {
  return (
    <div class="mt-2 flex flex-wrap gap-2" role="group" aria-label={props.label}>
      <For each={props.options}>
        {(option) => (
          <button
            class="flex items-center gap-2 rounded-2xl border px-3 py-2 text-sm"
            classList={{
              "border-(--accent) bg-(--accent-soft) font-bold": props.value() === option.id,
              "border-(--line-strong) hover:bg-(--fill-soft)": props.value() !== option.id,
            }}
            aria-pressed={props.value() === option.id}
            onClick={() => props.onSelect(option.id)}
          >
            {/* The condition is the value, not `!== undefined`. A render-prop
                child of `Show` is handed whatever `when` holds, so testing for
                `undefined` handed it the *result* of the test — a boolean — and
                every swatch was painted with `background: true`, which the parser
                discards. All of them drew as an empty outlined pill. */}
            <Show when={option.swatch}>
              {(swatch) => (
                <span
                  class="h-4 w-6 shrink-0 rounded-full border border-(--line-strong)"
                  style={swatchStyle(swatch())}
                />
              )}
            </Show>
            {option.label}
          </button>
        )}
      </For>
    </div>
  );
}
