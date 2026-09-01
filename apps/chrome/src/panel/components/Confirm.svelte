<script lang="ts">
  import type { ConfirmRequestInfo, ConfirmDecision, VaultState } from "@dacci/core";
  import { sendPanelRequest } from "../api";

  let { request, ondone } = $props<{
    request: ConfirmRequestInfo;
    ondone: (state: VaultState) => void;
  }>();

  let error = $state("");
  let deciding = $state(false);

  $effect(() => {
    request;
    deciding = false;
    error = "";
  });

  async function decide(decision: ConfirmDecision) {
    deciding = true;
    error = "";
    try {
      const res = await sendPanelRequest<{ type: "vault:state"; state: VaultState }>({
        type: "vault:confirmDecision",
        decision,
      });
      if (res.state.confirmRequest) {
        ondone(res.state);
      } else {
        close();
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      deciding = false;
    }
  }

  function close() {
    if (window.parent === window) {
      window.close();
    } else {
      window.parent.postMessage({ type: "dacci:closePanel" }, "*");
    }
  }
</script>

<div class="space-y-4">
  <h2 class="text-base font-medium">署名の確認</h2>
  <p class="text-gray-600 dark:text-gray-300">{request.site} からの署名リクエストです。</p>

  <div class="rounded border border-gray-300 p-3 dark:border-gray-600">
    <span class="block text-xs text-gray-500 dark:text-gray-400">イベント種別</span>
    <p class="font-mono text-sm">kind: {request.kind}</p>
  </div>

  <div>
    <span class="mb-1 block text-xs text-gray-500 dark:text-gray-400">内容</span>
    <pre class="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded border border-gray-300 bg-gray-50 p-3 font-mono text-xs text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200">{request.content}</pre>
  </div>

  {#if request.tags.length > 0}
    <div>
      <span class="mb-1 block text-xs text-gray-500 dark:text-gray-400">タグ</span>
      <pre class="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded border border-gray-300 bg-gray-50 p-3 font-mono text-xs text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200">{JSON.stringify(request.tags)}</pre>
    </div>
  {/if}

  {#if error}
    <p class="text-sm text-red-600">{error}</p>
  {/if}

  <div class="grid grid-cols-2 gap-2">
    <button
      type="button"
      class="rounded bg-blue-600 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      onclick={() => decide("alwaysAllow")}
      disabled={deciding}
    >
      常に許可
    </button>
    <button
      type="button"
      class="rounded border border-blue-500 py-2 font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:text-blue-400 dark:hover:bg-blue-950"
      onclick={() => decide("allow")}
      disabled={deciding}
    >
      許可
    </button>
    <button
      type="button"
      class="rounded border border-red-500 py-2 font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950"
      onclick={() => decide("deny")}
      disabled={deciding}
    >
      許可しない
    </button>
    <button
      type="button"
      class="rounded bg-red-600 py-2 font-medium text-white hover:bg-red-700 disabled:opacity-50"
      onclick={() => decide("alwaysDeny")}
      disabled={deciding}
    >
      常に許可しない
    </button>
  </div>
</div>