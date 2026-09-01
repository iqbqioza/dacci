<script lang="ts">
  import type { PanelRequest } from "@dacci/core";
  import { sendPanelRequest } from "../api";

  let { ondone, onclose } = $props<{
    ondone: () => void;
    onclose: () => void;
  }>();

  let name = $state("");
  let error = $state("");
  let generating = $state(false);

  async function submit() {
    generating = true;
    error = "";
    try {
      const request: PanelRequest = name.trim()
        ? { type: "vault:createKey", name: name.trim() }
        : { type: "vault:createKey" };
      await sendPanelRequest(request);
      ondone();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      generating = false;
    }
  }
</script>

<div class="space-y-3">
  <button
    type="button"
    class="text-gray-500 hover:text-gray-900 "
    onclick={onclose}
  >
    ← 戻る
  </button>
  <h2 class="text-base font-medium">新しい鍵の生成</h2>
  <label class="block">
    <span class="mb-1 block text-xs text-gray-500 ">鍵の名前 (省略可)</span>
    <input
      type="text"
      bind:value={name}
      placeholder="鍵の名前"
      class="w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none   "
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
    class="w-full rounded bg-blue-600 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
    onclick={submit}
    disabled={generating}
  >
    生成
  </button>
</div>