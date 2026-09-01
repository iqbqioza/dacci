<script lang="ts">
  import type { VaultState } from "@dacci/core";
  import { sendPanelRequest } from "../api";

  let { ondone } = $props<{ ondone: (state: VaultState) => void }>();

  let passphrase = $state("");
  let error = $state("");

  async function submit() {
    error = "";
    try {
      const res = await sendPanelRequest({ type: "vault:unlock", passphrase });
      if (res.type === "vault:unlocked") {
        ondone(res.state);
      } else if (res.type === "vault:error") {
        error = res.error;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<div class="space-y-3">
  <h2 class="text-base font-medium">ロック解除</h2>
  <p class="text-gray-600 dark:text-gray-300">パスフレーズを入力してロックを解除してください。</p>
  <label class="block">
    <span class="mb-1 block text-xs text-gray-500 dark:text-gray-400">パスフレーズ</span>
    <input
      type="password"
      bind:value={passphrase}
      placeholder="パスフレーズ"
      class="w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
      onkeydown={(e) => {
        if (e.key === "Enter") submit();
      }}
    />
  </label>
  {#if error}
    <p class="text-sm text-red-600">{error}</p>
  {/if}
  <button
    type="button"
    class="w-full rounded bg-blue-600 py-2 font-medium text-white hover:bg-blue-700"
    onclick={submit}
  >
    解除する
  </button>
</div>