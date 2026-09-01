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
  let editingKeyId = $state<string | null>(null);
  let editName = $state("");

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

  function startEdit(keyId: string, name: string) {
    editingKeyId = keyId;
    editName = name;
  }

  function cancelEdit() {
    editingKeyId = null;
    editName = "";
  }

  async function saveEdit() {
    if (!editingKeyId) return;
    const name = editName.trim();
    if (!name) return;
    error = "";
    try {
      await sendPanelRequest({ type: "vault:renameKey", keyId: editingKeyId, name });
      editingKeyId = null;
      editName = "";
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
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
        {#if editingKeyId === key.id}
          <div class="flex items-center gap-2 rounded border border-blue-500 bg-blue-50 px-3 py-2">
            <input
              type="text"
              bind:value={editName}
              placeholder="鍵の名前"
              class="flex-1 rounded border border-gray-300 px-2 py-1 focus:border-blue-500 focus:outline-none"
              onkeydown={(e) => {
                if (e.key === "Enter") saveEdit();
                if (e.key === "Escape") cancelEdit();
              }}
            />
            <button
              type="button"
              class="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
              onclick={saveEdit}
            >
              保存
            </button>
            <button
              type="button"
              class="rounded bg-gray-200 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-300"
              onclick={cancelEdit}
            >
              取消
            </button>
          </div>
        {:else}
          <div
            class="flex w-full items-center rounded border px-3 py-2 {key.id === activeKeyId
              ? 'border-blue-500 bg-blue-50'
              : 'border-gray-300 hover:bg-gray-50'}"
          >
            <button type="button" class="flex-1 text-left" onclick={() => selectKey(key.id)}>
              <span class="block font-medium">{key.name}</span>
              <span class="block text-xs text-gray-500">{shortNpub(key.npub)}</span>
            </button>
            <button
              type="button"
              title="名前を変更"
              class="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
              onclick={() => startEdit(key.id, key.name)}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="1.5"
                stroke="currentColor"
                class="h-4 w-4"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z"
                />
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
            </button>
          </div>
        {/if}
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