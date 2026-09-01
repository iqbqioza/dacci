<script lang="ts">
  import { onMount } from "svelte";
  import type { ExportedKey } from "@dacci/core";
  import { sendPanelRequest } from "../api";

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

<div class="space-y-3">
  <button
    type="button"
    class="text-gray-500 hover:text-gray-900"
    onclick={onclose}
  >
    ← 一覧に戻る
  </button>

  <label class="block">
    <span class="mb-1 block text-xs text-gray-500">鍵の名前</span>
    <input
      type="text"
      bind:value={name}
      class="w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
    />
  </label>

  {#if error}
    <p class="text-sm text-red-600">{error}</p>
  {/if}

  {#if key}
    <div>
      <span class="mb-1 block text-xs text-gray-500">秘密鍵 (nsec)</span>
      <div class="rounded border border-gray-300 bg-gray-50 px-3 py-2">
        <p class="break-all font-mono text-xs text-gray-700">
          {revealed ? key.nsec : `${key.nsec.slice(0, 12)}...${key.nsec.slice(-8)}`}
        </p>
      </div>
      <div class="mt-2 flex gap-2">
        <button
          type="button"
          class="rounded bg-gray-200 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-300"
          onclick={() => (revealed = !revealed)}
        >
          {revealed ? "隠す" : "表示"}
        </button>
        <button
          type="button"
          class="rounded bg-gray-200 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-300"
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
</div>