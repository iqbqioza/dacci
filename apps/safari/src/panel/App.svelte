<script lang="ts">
  import { onMount } from "svelte";
  import type { AppSettings, VaultState } from "@dacci/core";
  import { sendPanelRequest } from "./api";
  import Setup from "./components/Setup.svelte";
  import Unlock from "./components/Unlock.svelte";
  import KeyManager from "./components/KeyManager.svelte";
  import KeySelect from "./components/KeySelect.svelte";
  import Confirm from "./components/Confirm.svelte";
  import Settings from "./components/Settings.svelte";

  let vaultState = $state<VaultState | null>(null);
  let error = $state("");
  let reason = $state("");
  let selectMode = $state(false);
  let confirmMode = $state(false);
  let settingsView = $state(false);
  let settings = $state<AppSettings | null>(null);

  async function loadSettings() {
    const res = await sendPanelRequest<{ type: "vault:settings"; settings: AppSettings }>({
      type: "vault:getSettings",
    });
    settings = res.settings;
  }

  async function updateSettings(next: AppSettings) {
    const res = await sendPanelRequest<{ type: "vault:settings"; settings: AppSettings }>({
      type: "vault:setSettings",
      settings: next,
    });
    settings = res.settings;
  }

  function close() {
    if (window.parent === window) {
      window.close();
    } else {
      window.parent.postMessage({ type: "dacci:closePanel" }, "*");
    }
  }

  function updateView(state: VaultState) {
    vaultState = state;
    error = "";
    confirmMode = state.status === "unlocked" && state.confirmRequest !== null;
    selectMode = !state.confirmRequest && state.pendingRequests > 0;
  }

  async function refresh() {
    try {
      const res = await sendPanelRequest<{ type: "vault:state"; state: VaultState }>({
        type: "vault:getState",
      });
      updateView(res.state);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function onUnlocked(state: VaultState) {
    updateView(state);
  }

  function onKeySelectDone(state: VaultState) {
    updateView(state);
  }

  onMount(async () => {
    reason = new URLSearchParams(window.location.search).get("reason") ?? "";
    void browser.runtime.sendMessage({ type: "dacci:panelOpen" });
    const onHide = () => {
      void browser.runtime.sendMessage({ type: "dacci:panelClose" });
    };
    window.addEventListener("pagehide", onHide);
    browser.runtime.onMessage.addListener((message) => {
      if (message?.type === "dacci:stateChanged") {
        void refresh();
      }
    });
    try {
      const [stateRes, settingsRes] = await Promise.all([
        sendPanelRequest<{ type: "vault:state"; state: VaultState }>({ type: "vault:getState" }),
        sendPanelRequest<{ type: "vault:settings"; settings: AppSettings }>({ type: "vault:getSettings" }),
      ]);
      updateView(stateRes.state);
      settings = settingsRes.settings;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });
</script>

<div class="flex h-full flex-col bg-white text-gray-900">
  <header class="flex items-center justify-between border-b border-gray-200 px-4 py-3">
    <div class="flex items-center gap-2">
      <img src="icons/icon-32.png" alt="Dacci" class="h-8 w-8" />
    </div>
    <div class="flex items-center gap-2">
      <button
        type="button"
        title="設定"
        class="rounded p-1.5 text-gray-500 hover:bg-gray-100"
        onclick={() => (settingsView = !settingsView)}
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
      <button
        type="button"
        class="rounded px-2 py-1 text-gray-500 hover:bg-gray-100"
        onclick={close}
      >
        閉じる
      </button>
    </div>
  </header>
  <main class="flex-1 overflow-y-auto p-4 text-sm">
    {#if settingsView && settings}
      <Settings settings={settings} onchange={updateSettings} onclose={() => (settingsView = false)} />
    {:else if confirmMode && vaultState?.confirmRequest}
      <Confirm
        request={vaultState.confirmRequest}
        keysCount={vaultState.keys.length}
        ondone={updateView}
      />
    {:else}
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
        <KeySelect vault={vaultState} ondone={onKeySelectDone} />
      {:else}
        <KeyManager
          vault={vaultState}
          pending={vaultState.pendingRequests}
          onselect={() => (selectMode = true)}
        />
      {/if}
    {/if}
  </main>
</div>