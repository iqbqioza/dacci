<script lang="ts">
  import type { AppSettings, Theme } from "@dacci/core";
  import Dropdown from "./Dropdown.svelte";

  let { settings, onchange, onclose } = $props<{
    settings: AppSettings;
    onchange: (settings: AppSettings) => void;
    onclose: () => void;
  }>();

  const themeOptions: { value: string | number | null; label: string }[] = [
    { value: "light", label: "ライトモード" },
    { value: "dark", label: "ダークモード" },
    { value: "system", label: "システム" },
  ];

  const lockOptions: { value: string | number | null; label: string }[] = [
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

  <label class="block">
    <span class="mb-1 block text-xs text-gray-500 dark:text-gray-400">表示色</span>
    <Dropdown
      value={settings.theme}
      options={themeOptions}
      onselect={(value) => onchange({ ...settings, theme: value as Theme })}
    />
  </label>

  <label class="block">
    <span class="mb-1 block text-xs text-gray-500 dark:text-gray-400">ロック時間</span>
    <Dropdown
      value={settings.autoLockMinutes}
      options={lockOptions}
      onselect={(value) => onchange({ ...settings, autoLockMinutes: value as number | null })}
    />
  </label>
</div>