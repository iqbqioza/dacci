<script lang="ts">
  import type { AppSettings, Theme } from "@dacci/core";

  let { settings, onchange, onclose } = $props<{
    settings: AppSettings;
    onchange: (settings: AppSettings) => void;
    onclose: () => void;
  }>();

  const themeOptions: { value: Theme; label: string }[] = [
    { value: "light", label: "ライトモード" },
    { value: "dark", label: "ダークモード" },
    { value: "system", label: "システム" },
  ];

  const lockOptions: { value: number | null; label: string }[] = [
    { value: 1, label: "1分" },
    { value: 5, label: "5分" },
    { value: 15, label: "15分" },
    { value: 30, label: "30分" },
    { value: 60, label: "1時間" },
    { value: 180, label: "3時間" },
    { value: 360, label: "6時間" },
    { value: 720, label: "12時間" },
    { value: 1440, label: "1日" },
    { value: null, label: "なし" },
  ];
</script>

<div class="space-y-5">
  <button type="button" class="text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100" onclick={onclose}>
    ← 戻る
  </button>
  <h2 class="text-base font-medium">設定</h2>

  <div>
    <span class="mb-2 block text-xs text-gray-500 dark:text-gray-400">表示色</span>
    <div class="space-y-2">
      {#each themeOptions as option}
        <button
          type="button"
          class="w-full rounded border px-3 py-2 text-left {settings.theme === option.value
            ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
            : 'border-gray-300 hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800'}"
          onclick={() => onchange({ ...settings, theme: option.value })}
        >
          {option.label}
        </button>
      {/each}
    </div>
  </div>

  <div>
    <span class="mb-2 block text-xs text-gray-500 dark:text-gray-400">ロック時間</span>
    <div class="grid grid-cols-2 gap-2">
      {#each lockOptions as option}
        <button
          type="button"
          class="rounded border px-3 py-2 text-left {settings.autoLockMinutes === option.value
            ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
            : 'border-gray-300 hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800'}"
          onclick={() => onchange({ ...settings, autoLockMinutes: option.value })}
        >
          {option.label}
        </button>
      {/each}
    </div>
  </div>
</div>