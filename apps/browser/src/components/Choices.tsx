import { For, Show } from "solid-js";

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
            <Show when={option.swatch !== undefined}>
              {(swatch) => (
                <span
                  class="h-4 w-6 shrink-0 rounded-full border border-(--line-strong)"
                  // A string, not a typed pair: a swatch may be a gradient as
                  // well as a colour, and the type only admits colours.
                  style={`background-color: ${swatch()}`}
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
