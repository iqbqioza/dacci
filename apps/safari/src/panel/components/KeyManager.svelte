<script lang="ts">
  import type { PanelRequest, VaultState } from "@dacci/core";
  import { sendPanelRequest } from "../api";

  let { vault, onlock } = $props<{
    vault: VaultState;
    onlock: (state: VaultState) => void;
  }>();

  let keys = $state<VaultState["keys"]>([]);
  let activeKeyId = $state<string | null>(null);
  let newKeyName = $state("");
  let nsec = $state("");
  let error = $state("");

  $effect(() => {
    keys = vault.keys;
    activeKeyId = vault.activeKeyId;
  });

  async function refresh() {
    const res = await sendPanelRequest<{ type: "vault:state"; state: VaultState }>({
      type: "vault:getState",
    });
    keys = res.state.keys;
    activeKeyId = res.state.activeKeyId;
  }

  async function generate() {
    error = "";
    try {
      const request: PanelRequest = newKeyName
        ? { type: "vault:createKey", name: newKeyName }
        : { type: "vault:createKey" };
      await sendPanelRequest(request);
      newKeyName = "";
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function importKey() {
    error = "";
    try {
      await sendPanelRequest({ type: "vault:importKey", nsec });
      nsec = "";
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function selectKey(keyId: string) {
    await sendPanelRequest({ type: "vault:selectKey", keyId });
    await refresh();
  }

  async function lock() {
    const res = await sendPanelRequest<{ type: "vault:state"; state: VaultState }>({
      type: "vault:lock",
    });
    onlock(res.state);
  }

  function shortNpub(npub: string): string {
    return `${npub.slice(0, 12)}...${npub.slice(-8)}`;
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h2 class="text-base font-medium">鍵の管理</h2>
    <button
      type="button"
      class="rounded bg-gray-200 px-3 py-1 font-medium text-gray-700 hover:bg-gray-300"
      onclick={lock}
    >
      ロック
    </button>
  </div>

  {#if error}
    <p class="text-sm text-red-600">{error}</p>
  {/if}

  <ul class="space-y-2">
    {#each keys as key (key.id)}
      <li>
        <button
          type="button"
          class="w-full rounded border px-3 py-2 text-left {key.id === activeKeyId
            ? 'border-blue-500 bg-blue-50'
            : 'border-gray-300 hover:bg-gray-50'}"
          onclick={() => selectKey(key.id)}
        >
          <span class="block font-medium">{key.name}</span>
          <span class="block text-xs text-gray-500">{shortNpub(key.npub)}</span>
        </button>
      </li>
    {/each}
    {#if keys.length === 0}
      <li class="text-gray-500">鍵がありません。下から生成またはインポートしてください。</li>
    {/if}
  </ul>

  <div class="space-y-2 border-t border-gray-200 pt-3">
    <div class="flex gap-2">
      <input
        type="text"
        bind:value={newKeyName}
        placeholder="鍵の名前 (省略可)"
        class="flex-1 rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
      />
      <button
        type="button"
        class="rounded bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-700"
        onclick={generate}
      >
        生成
      </button>
    </div>
    <div class="flex gap-2">
      <input
        type="text"
        bind:value={nsec}
        placeholder="nsec1... をインポート"
        class="flex-1 rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
      />
      <button
        type="button"
        class="rounded bg-gray-600 px-3 py-2 font-medium text-white hover:bg-gray-700"
        onclick={importKey}
      >
        インポート
      </button>
    </div>
  </div>
</div>