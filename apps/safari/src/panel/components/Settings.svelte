<script lang="ts">
  import type { AppSettings } from "@dacci/core";
  import { sendPanelRequest } from "../api";
  import Dropdown from "./Dropdown.svelte";

  let { settings, onchange, onclose } = $props<{
    settings: AppSettings;
    onchange: (settings: AppSettings) => void;
    onclose: () => void;
  }>();

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

  let currentPassphrase = $state("");
  let newPassphrase = $state("");
  let confirmPassphrase = $state("");
  let passError = $state("");
  let passSuccess = $state(false);
  let changing = $state(false);

  async function changePassphrase() {
    if (changing) {
      return;
    }
    passError = "";
    passSuccess = false;
    if (newPassphrase.length < 8) {
      passError = "新パスフレーズは8文字以上にしてください";
      return;
    }
    if (newPassphrase !== confirmPassphrase) {
      passError = "新パスフレーズが一致しません";
      return;
    }
    changing = true;
    try {
      const res = await sendPanelRequest({
        type: "vault:changePassphrase",
        currentPassphrase,
        newPassphrase,
      });
      if (res.type === "vault:error") {
        passError = res.error;
      } else {
        currentPassphrase = "";
        newPassphrase = "";
        confirmPassphrase = "";
        passSuccess = true;
        setTimeout(() => (passSuccess = false), 3000);
      }
    } catch (e) {
      passError = e instanceof Error ? e.message : String(e);
    } finally {
      changing = false;
    }
  }
</script>

<div class="space-y-5">
  <button type="button" class="text-gray-500 hover:text-gray-900 " onclick={onclose}>
    ← 戻る
  </button>
  <h2 class="text-base font-medium">設定</h2>

  <label class="block">
    <span class="mb-1 block text-xs text-gray-500 ">ロック時間</span>
    <Dropdown
      value={settings.autoLockMinutes}
      options={lockOptions}
      onselect={(value) => onchange({ ...settings, autoLockMinutes: value as number | null })}
    />
  </label>

  <div class="space-y-2 border-t border-gray-200 pt-4 ">
    <h3 class="text-sm font-medium text-gray-700 ">パスフレーズ変更</h3>
    <input
      type="password"
      bind:value={currentPassphrase}
      placeholder="現在のパスフレーズ"
      class="w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none   "
    />
    <input
      type="password"
      bind:value={newPassphrase}
      placeholder="新パスフレーズ (8文字以上)"
      class="w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none   "
    />
    <input
      type="password"
      bind:value={confirmPassphrase}
      placeholder="パスフレーズ確認"
      class="w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none   "
      onkeydown={(e) => {
        if (e.key === "Enter") changePassphrase();
      }}
    />
    {#if passError}
      <p class="text-sm text-red-600">{passError}</p>
    {/if}
    {#if passSuccess}
      <p class="text-sm text-green-700 ">パスフレーズを変更しました。</p>
    {/if}
    <button
      type="button"
      class="w-full rounded bg-blue-600 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      onclick={changePassphrase}
      disabled={changing}
    >
      パスフレーズ更新
    </button>
  </div>
</div>