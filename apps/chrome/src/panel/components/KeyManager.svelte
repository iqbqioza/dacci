<script lang="ts">
  import type { VaultState } from "@dacci/core";
  import { sendPanelRequest } from "../api";
  import KeyDetail from "./KeyDetail.svelte";
  import KeyMenu from "./KeyMenu.svelte";
  import KeyImport from "./KeyImport.svelte";
  import KeyGenerate from "./KeyGenerate.svelte";

  let { vault, pending, onselect, onlock } = $props<{
    vault: VaultState;
    pending: number;
    onselect: () => void;
    onlock: (state: VaultState) => void;
  }>();

  let keys = $state<VaultState["keys"]>([]);
  let activeKeyId = $state<string | null>(null);
  let error = $state("");
  let detailKeyId = $state<string | null>(null);
  let view = $state<"list" | "menu" | "import" | "generate">("list");

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

  async function selectKey(keyId: string) {
    await sendPanelRequest({ type: "vault:selectKey", keyId });
    await refresh();
  }

  function closeDetail() {
    detailKeyId = null;
    void refresh();
  }

  async function doneAndBackToList() {
    view = "list";
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

{#if detailKeyId}
  <KeyDetail
    keyId={detailKeyId}
    initialName={keys.find((k) => k.id === detailKeyId)?.name ?? ""}
    onclose={closeDetail}
  />
{:else if view === "menu"}
  <KeyMenu
    onimport={() => (view = "import")}
    ongenerate={() => (view = "generate")}
    onclose={() => (view = "list")}
  />
{:else if view === "import"}
  <KeyImport ondone={doneAndBackToList} onclose={() => (view = "menu")} />
{:else if view === "generate"}
  <KeyGenerate ondone={doneAndBackToList} onclose={() => (view = "menu")} />
{:else}
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h2 class="text-base font-medium">鍵の管理</h2>
      <div class="flex items-center gap-2">
        <button
          type="button"
          title="鍵を追加"
          class="rounded bg-blue-600 p-1.5 text-white hover:bg-blue-700"
          onclick={() => (view = "menu")}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke-width="2"
            stroke="currentColor"
            class="h-4 w-4"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </button>
        <button
          type="button"
          class="rounded bg-gray-200 px-3 py-1 font-medium text-gray-700 hover:bg-gray-300"
          onclick={lock}
        >
          ロック
        </button>
      </div>
    </div>

    {#if error}
      <p class="text-sm text-red-600">{error}</p>
    {/if}

    {#if pending > 0}
      <div class="flex items-center justify-between gap-2 rounded bg-amber-50 px-3 py-2 text-amber-800">
        <span>保留中の要求があります</span>
        <button
          type="button"
          class="shrink-0 rounded bg-amber-600 px-2 py-1 text-xs font-medium text-white hover:bg-amber-700"
          onclick={onselect}
        >
          鍵を選択して処理
        </button>
      </div>
    {/if}

    <ul class="space-y-2">
      {#each keys as key (key.id)}
        <li>
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
              title="詳細"
              class="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
              onclick={() => (detailKeyId = key.id)}
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
        </li>
      {/each}
      {#if keys.length === 0}
        <li class="text-gray-500">鍵がありません。</li>
      {/if}
    </ul>
  </div>
{/if}