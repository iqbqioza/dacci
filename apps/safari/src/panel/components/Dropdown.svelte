<script lang="ts">
  let { value, options, onselect } = $props<{
    value: string | number | null;
    options: { value: string | number | null; label: string }[];
    onselect: (value: string | number | null) => void;
  }>();

  let open = $state(false);
  let rootEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (rootEl && !rootEl.contains(event.target as Node)) {
        open = false;
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  });

  function currentLabel(): string {
    return (
      options.find(
        (option: { value: string | number | null; label: string }) => option.value === value,
      )?.label ?? ""
    );
  }
</script>

<div bind:this={rootEl} class="relative">
  <button
    type="button"
    class="flex w-full items-center justify-between rounded border px-3 py-2 {open
      ? 'border-blue-500'
      : 'border-gray-300 dark:border-gray-600'}"
    onclick={() => (open = !open)}
  >
    <span class="text-gray-900 dark:text-gray-100">{currentLabel()}</span>
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke-width="2"
      stroke="currentColor"
      class="h-4 w-4 text-gray-400 transition-transform {open ? 'rotate-180' : ''}"
    >
      <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
    </svg>
  </button>
  {#if open}
    <ul
      class="absolute left-0 right-0 z-10 mt-1 max-h-56 overflow-y-auto rounded border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-800"
    >
      {#each options as option}
        <li>
          <button
            type="button"
            class="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700"
            onclick={() => {
              onselect(option.value);
              open = false;
            }}
          >
            <span class={option.value === value ? "font-medium text-blue-600 dark:text-blue-400" : "text-gray-700 dark:text-gray-200"}>
              {option.label}
            </span>
            {#if option.value === value}
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="2"
                stroke="currentColor"
                class="h-4 w-4 text-blue-600 dark:text-blue-400"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>