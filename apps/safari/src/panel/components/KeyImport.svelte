<script lang="ts">
  import { decodeNsec, isValidSecretKey } from "@dacci/core";
  import { sendPanelRequest } from "../api";

  let { ondone, onclose } = $props<{
    ondone: () => void;
    onclose: () => void;
  }>();

  let nsec = $state("");
  let error = $state("");
  let importing = $state(false);

  let nsecValid = $derived.by(() => {
    if (!nsec) {
      return false;
    }
    try {
      return isValidSecretKey(decodeNsec(nsec));
    } catch {
      return false;
    }
  });

  async function submit() {
    if (!nsecValid || importing) {
      return;
    }
    importing = true;
    error = "";
    try {
      await sendPanelRequest({ type: "vault:importKey", nsec });
      ondone();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      importing = false;
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
  <h2 class="text-base font-medium">鍵のインポート</h2>
  <label class="block">
    <span class="mb-1 block text-xs text-gray-500 ">秘密鍵 (nsec)</span>
    <input
      type="text"
      bind:value={nsec}
      placeholder="nsec1..."
      class="w-full rounded border border-gray-300 px-3 py-2 font-mono text-xs focus:border-blue-500 focus:outline-none   "
      onkeydown={(e) => {
        if (e.key === "Enter") submit();
      }}
    />
  </label>
  {#if nsec && !nsecValid}
    <p class="text-sm text-red-600">有効な nsec ではありません</p>
  {/if}
  {#if error}
    <p class="text-sm text-red-600">{error}</p>
  {/if}
  <button
    type="button"
    class="w-full rounded bg-blue-600 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
    onclick={submit}
    disabled={importing || !nsecValid}
  >
    インポート
  </button>
</div>