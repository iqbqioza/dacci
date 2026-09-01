<script lang="ts">
  import type { VaultState } from "@dacci/core";
  import { sendPanelRequest } from "../api";

  let { vault, ondone } = $props<{ vault: VaultState; ondone: (state: VaultState) => void }>();

  let keys = $state<VaultState["keys"]>([]);
  let activeKeyId = $state<string | null>(null);
  let error = $state("");

  $effect(() => {
    keys = vault.keys;
    activeKeyId = vault.activeKeyId;
  });

  async function choose(keyId: string) {
    error = "";
    try {
      await sendPanelRequest({ type: "vault:selectKey", keyId });
      await sendPanelRequest({ type: "vault:flushPending" });
      const res = await sendPanelRequest<{ type: "vault:state"; state: VaultState }>({
        type: "vault:getState",
      });
      if (res.state.confirmRequest) {
        ondone(res.state);
      } else {
        close();
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function createAndUse() {
    error = "";
    try {
      await sendPanelRequest({ type: "vault:createKey" });
      await sendPanelRequest({ type: "vault:flushPending" });
      const res = await sendPanelRequest<{ type: "vault:state"; state: VaultState }>({
        type: "vault:getState",
      });
      if (res.state.confirmRequest) {
        ondone(res.state);
      } else {
        close();
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function close() {
    if (window.parent === window) {
      window.close();
    } else {
      window.parent.postMessage({ type: "dacci:closePanel" }, "*");
    }
  }

  function shortNpub(npub: string): string {
    return `${npub.slice(0, 12)}...${npub.slice(-8)}`;
  }
</script>

<div class="space-y-3">
  <h2 class="text-base font-medium">鍵を選択</h2>
  <p class="text-gray-600 ">この要求を処理する鍵を選択してください。</p>
  {#if error}
    <p class="text-sm text-red-600">{error}</p>
  {/if}
  <ul class="space-y-2">
    {#each keys as key (key.id)}
      <li>
        <button
          type="button"
          class="w-full rounded border px-3 py-2 text-left {key.id === activeKeyId
            ? 'border-blue-500 bg-blue-50 '
            : 'border-gray-300 hover:bg-gray-50 '}"
          onclick={() => choose(key.id)}
        >
          <span class="block font-medium">{key.name}</span>
          <span class="block text-xs text-gray-500 ">{shortNpub(key.npub)}</span>
        </button>
      </li>
    {/each}
    {#if keys.length === 0}
      <li class="text-gray-500 ">鍵がありません。</li>
    {/if}
  </ul>
  {#if keys.length === 0}
    <button
      type="button"
      class="w-full rounded bg-blue-600 py-2 font-medium text-white hover:bg-blue-700"
      onclick={createAndUse}
    >
      鍵を生成して続行
    </button>
  {/if}
</div>