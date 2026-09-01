<script lang="ts">
  import { onMount } from "svelte";
  import type { VaultState } from "@dacci/core";
  import { sendPanelRequest } from "./api";
  import Setup from "./components/Setup.svelte";
  import Unlock from "./components/Unlock.svelte";
  import KeyManager from "./components/KeyManager.svelte";

  let vaultState = $state<VaultState | null>(null);
  let error = $state("");

  onMount(async () => {
    try {
      const res = await sendPanelRequest<{ type: "vault:state"; state: VaultState }>({
        type: "vault:getState",
      });
      vaultState = res.state;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });
</script>

<div class="flex h-full flex-col bg-white text-gray-900">
  <header class="flex items-center justify-between border-b border-gray-200 px-4 py-3">
    <h1 class="text-lg font-semibold">Dacci</h1>
    <button
      type="button"
      class="rounded px-2 py-1 text-gray-500 hover:bg-gray-100"
      onclick={() => window.parent.postMessage({ type: "dacci:closePanel" }, "*")}
    >
      閉じる
    </button>
  </header>
  <main class="flex-1 overflow-y-auto p-4 text-sm">
    {#if error}
      <p class="text-red-600">{error}</p>
    {:else if !vaultState}
      <p class="text-gray-500">読み込み中...</p>
    {:else if vaultState.status === "uninitialized"}
      <Setup ondone={(s) => (vaultState = s)} />
    {:else if vaultState.status === "locked"}
      <Unlock ondone={(s) => (vaultState = s)} />
    {:else}
      <KeyManager vault={vaultState} onlock={(s) => (vaultState = s)} />
    {/if}
  </main>
</div>