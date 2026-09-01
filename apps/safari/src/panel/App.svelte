<script lang="ts">
  import { onMount } from "svelte";
  import type { VaultState } from "@dacci/core";
  import { sendPanelRequest } from "./api";
  import Setup from "./components/Setup.svelte";
  import Unlock from "./components/Unlock.svelte";
  import KeyManager from "./components/KeyManager.svelte";
  import KeySelect from "./components/KeySelect.svelte";

  let vaultState = $state<VaultState | null>(null);
  let error = $state("");
  let reason = $state("");
  let selectMode = $state(false);

  function close() {
    if (window.parent === window) {
      window.close();
    } else {
      window.parent.postMessage({ type: "dacci:closePanel" }, "*");
    }
  }

  async function onUnlocked(state: VaultState) {
    vaultState = state;
    selectMode = state.pendingRequests > 0;
  }

  onMount(async () => {
    reason = new URLSearchParams(window.location.search).get("reason") ?? "";
    try {
      const res = await sendPanelRequest<{ type: "vault:state"; state: VaultState }>({
        type: "vault:getState",
      });
      vaultState = res.state;
      selectMode = res.state.pendingRequests > 0;
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
      onclick={close}
    >
      閉じる
    </button>
  </header>
  <main class="flex-1 overflow-y-auto p-4 text-sm">
    {#if reason === "unlock" && vaultState && vaultState.status !== "unlocked"}
      <p class="mb-3 rounded bg-amber-50 px-3 py-2 text-amber-800">
        {vaultState.status === "uninitialized"
          ? "サービスの要求を処理するには、初回セットアップが必要です。"
          : "サービスの要求を処理するには、ロックを解除してください。"}
      </p>
    {/if}
    {#if error}
      <p class="text-red-600">{error}</p>
    {:else if !vaultState}
      <p class="text-gray-500">読み込み中...</p>
    {:else if vaultState.status === "uninitialized"}
      <Setup ondone={onUnlocked} />
    {:else if vaultState.status === "locked"}
      <Unlock ondone={onUnlocked} />
    {:else if selectMode}
      <KeySelect vault={vaultState} />
    {:else}
      <KeyManager
        vault={vaultState}
        pending={vaultState.pendingRequests}
        onselect={() => (selectMode = true)}
        onlock={(s) => (vaultState = s)}
      />
    {/if}
  </main>
</div>