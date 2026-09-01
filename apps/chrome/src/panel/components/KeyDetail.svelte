<script lang="ts">
  import { onMount } from "svelte";
  import type { ExportedKey } from "@dacci/core";
  import { sendPanelRequest } from "../api";
  import SitePermissions from "./SitePermissions.svelte";

  let { keyId, initialName, onclose } = $props<{
    keyId: string;
    initialName: string;
    onclose: () => void;
  }>();

  let name = $state("");
  let key = $state<ExportedKey | null>(null);
  let revealed = $state(false);
  let copied = $state(false);
  let error = $state("");
  let saving = $state(false);
  let deleting = $state(false);
  let confirmingDelete = $state(false);
  let viewSites = $state(false);

  onMount(async () => {
    name = initialName;
    try {
      const res = await sendPanelRequest({ type: "vault:exportKey", keyId });
      if (res.type === "vault:exported") {
        key = res.key;
      } else if (res.type === "vault:error") {
        error = res.error;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });

  async function ok() {
    saving = true;
    error = "";
    try {
      const trimmed = name.trim();
      if (trimmed && trimmed !== initialName) {
        await sendPanelRequest({ type: "vault:renameKey", keyId, name: trimmed });
      }
      onclose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  async function deleteKey() {
    deleting = true;
    error = "";
    try {
      await sendPanelRequest({ type: "vault:deleteKey", keyId });
      onclose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      deleting = false;
    }
  }

  async function copy() {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key.nsec);
      copied = true;
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = key.nsec;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      copied = true;
    }
    setTimeout(() => (copied = false), 1500);
  }
</script>

{#if viewSites}
  <SitePermissions keyId={keyId} onclose={() => (viewSites = false)} />
{:else if confirmingDelete}
  <div class="space-y-3">
    <h2 class="text-base font-medium">鍵を削除</h2>
    <p class="text-gray-600 dark:text-gray-300">
      「{name || initialName}」を削除しますか？<br />この操作は取り消せません。
    </p>
    {#if error}
      <p class="text-sm text-red-600">{error}</p>
    {/if}
    <button
      type="button"
      class="w-full rounded bg-red-600 py-2 font-medium text-white hover:bg-red-700 disabled:opacity-50"
      onclick={deleteKey}
      disabled={deleting}
    >
      削除
    </button>
    <button
      type="button"
      class="w-full rounded bg-gray-200 py-2 font-medium text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
      onclick={() => (confirmingDelete = false)}
    >
      キャンセル
    </button>
  </div>
{:else}
  <div class="space-y-3">
    <button
      type="button"
      class="text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
      onclick={onclose}
    >
      ← 一覧に戻る
    </button>

    <label class="block">
      <span class="mb-1 block text-xs text-gray-500 dark:text-gray-400">鍵の名前</span>
      <input
        type="text"
        bind:value={name}
        class="w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
      />
    </label>

    {#if error}
      <p class="text-sm text-red-600">{error}</p>
    {/if}

    {#if key}
      <div>
        <span class="mb-1 block text-xs text-gray-500 dark:text-gray-400">秘密鍵 (nsec)</span>
        <input
          type={revealed ? "text" : "password"}
          readonly
          value={key.nsec}
          class="w-full rounded border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-700 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
        />
        <div class="mt-2 flex gap-2">
          <button
            type="button"
            class="rounded bg-gray-200 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
            onclick={() => (revealed = !revealed)}
          >
            {revealed ? "隠す" : "表示"}
          </button>
          <button
            type="button"
            class="rounded bg-gray-200 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
            onclick={copy}
          >
            {copied ? "コピーしました" : "コピー"}
          </button>
        </div>
      </div>
    {/if}

    <button
      type="button"
      class="w-full rounded bg-blue-600 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      onclick={ok}
      disabled={saving}
    >
      OK
    </button>
    <button
      type="button"
      class="w-full rounded border border-blue-300 py-2 font-medium text-blue-600 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-400 dark:hover:bg-blue-950"
      onclick={() => (viewSites = true)}
    >
      許可しているサイトを確認
    </button>
    <button
      type="button"
      class="w-full rounded border border-red-300 py-2 font-medium text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
      onclick={() => (confirmingDelete = true)}
    >
      鍵を削除
    </button>
  </div>
{/if}