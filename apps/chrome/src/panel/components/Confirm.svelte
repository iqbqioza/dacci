<script lang="ts">
  import type { ConfirmRequestInfo, ConfirmDecision, VaultState } from "@signr/core";
  import { decodeNsec, isValidSecretKey } from "@signr/core";
  import { sendPanelRequest } from "../api";

  let { request, keysCount, ondone } = $props<{
    request: ConfirmRequestInfo;
    keysCount: number;
    ondone: (state: VaultState) => void;
  }>();

  let error = $state("");
  let deciding = $state(false);
  let creatingKey = $state(false);
  let importMode = $state(false);
  let nsec = $state("");
  let importing = $state(false);

  let nsecValid = $derived.by(() => {
    if (!nsec) {
      return false;
    }
    try {
      return isValidSecretKey(decodeNsec(nsec));
    } catch {
      return false;
    }
  });

  $effect(() => {
    request;
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
      deciding = false;
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

  async function createKeyAndContinue() {
    creatingKey = true;
    error = "";
    try {
      await sendPanelRequest({ type: "vault:createKey" });
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
    } finally {
      creatingKey = false;
    }
  }

  async function importAndContinue() {
    if (!nsecValid || importing) {
      return;
    }
    importing = true;
    error = "";
    try {
      await sendPanelRequest({ type: "vault:importKey", nsec });
      const res = await sendPanelRequest<{ type: "vault:state"; state: VaultState }>({
        type: "vault:getState",
      });
      importMode = false;
      if (res.state.confirmRequest) {
        ondone(res.state);
      } else {
        close();
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      importing = false;
    }
  }

  function close() {
    if (window.parent === window) {
      window.close();
    } else {
      window.parent.postMessage({ type: "signr:closePanel" }, "*");
    }
  }
</script>

<div class="space-y-4">
  <h2 class="text-base font-medium">Signing Confirmation</h2>
  <p class="text-gray-600 ">{request.site}  is requesting a signature.</p>

  <div class="rounded border border-gray-300 p-3 ">
    <span class="block text-xs text-gray-500 ">Event kind</span>
    <p class="font-mono text-sm">kind: {request.kind}</p>
  </div>

  <div>
    <span class="mb-1 block text-xs text-gray-500 ">Content</span>
    <pre class="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded border border-gray-300 bg-gray-50 p-3 font-mono text-xs text-gray-700   ">{request.content}</pre>
  </div>

  {#if request.tags.length > 0}
    <div>
      <span class="mb-1 block text-xs text-gray-500 ">Tags</span>
      <pre class="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded border border-gray-300 bg-gray-50 p-3 font-mono text-xs text-gray-700   ">{JSON.stringify(request.tags)}</pre>
    </div>
  {/if}

  {#if error}
    <p class="text-sm text-red-600">{error}</p>
  {/if}

  {#if keysCount === 0}
    <p class="text-gray-600 ">No keys yet. Generate or import a key first.</p>
    {#if importMode}
      <input
        type="text"
        bind:value={nsec}
        placeholder="nsec1..."
        class="w-full rounded border border-gray-300 px-3 py-2 font-mono text-xs focus:border-blue-500 focus:outline-none   "
        onkeydown={(e) => {
          if (e.key === "Enter") importAndContinue();
        }}
      />
      <button
        type="button"
        class="w-full rounded bg-blue-600 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        onclick={importAndContinue}
        disabled={importing || !nsecValid}
      >
        Import
      </button>
      <button
        type="button"
        class="w-full rounded bg-gray-200 py-2 font-medium text-gray-700 hover:bg-gray-300  "
        onclick={() => (importMode = false)}
      >
        Cancel
      </button>
    {:else}
      <button
        type="button"
        class="w-full rounded bg-blue-600 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        onclick={createKeyAndContinue}
        disabled={creatingKey}
      >
        Generate key and continue
      </button>
      <button
        type="button"
        class="w-full rounded border border-blue-500 py-2 font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50 "
        onclick={() => (importMode = true)}
      >
        Import a key
      </button>
    {/if}
  {:else}
    <div class="flex flex-col gap-2">
    <button
      type="button"
      class="w-full rounded bg-blue-600 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      onclick={() => decide("alwaysAllow")}
      disabled={deciding}
    >
      Always Allow
    </button>
    <button
      type="button"
      class="w-full rounded border border-blue-500 py-2 font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50 "
      onclick={() => decide("allow")}
      disabled={deciding}
    >
      Allow
    </button>
    <button
      type="button"
      class="w-full rounded border border-red-500 py-2 font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 "
      onclick={() => decide("deny")}
      disabled={deciding}
    >
      Deny
    </button>
    <button
      type="button"
      class="w-full rounded border border-red-500 py-2 font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 "
      onclick={() => decide("alwaysDeny")}
      disabled={deciding}
    >
      Always Deny
    </button>
    </div>
  {/if}
</div>