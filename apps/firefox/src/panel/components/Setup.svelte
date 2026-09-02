<script lang="ts">
  import type { VaultState } from "@signr/core";
  import { sendPanelRequest } from "../api";

  let { ondone } = $props<{ ondone: (state: VaultState) => void }>();

  let passphrase = $state("");
  let confirm = $state("");
  let error = $state("");

  async function submit() {
    error = "";
    if (passphrase.length < 8) {
      error = "Passphrase must be at least 8 characters";
      return;
    }
    if (passphrase !== confirm) {
      error = "Passphrases do not match";
      return;
    }
    try {
      const res = await sendPanelRequest({ type: "vault:setup", passphrase });
      if (res.type === "vault:unlocked") {
        ondone(res.state);
      } else if (res.type === "vault:error") {
        error = res.error;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<div class="space-y-3">
  <h2 class="text-base font-medium">Initial Setup</h2>
  <p class="text-gray-600 ">Set a passphrase. Your keys will be encrypted and stored with it.</p>
  <label class="block">
    <span class="mb-1 block text-xs text-gray-500 ">Passphrase</span>
    <input
      type="password"
      bind:value={passphrase}
      placeholder="8+ characters"
      class="w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none   "
    />
  </label>
  <label class="block">
    <span class="mb-1 block text-xs text-gray-500 ">Confirm</span>
    <input
      type="password"
      bind:value={confirm}
      placeholder="Re-enter passphrase"
      class="w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none   "
    />
  </label>
  {#if error}
    <p class="text-sm text-red-600">{error}</p>
  {/if}
  <button
    type="button"
    class="w-full rounded bg-blue-600 py-2 font-medium text-white hover:bg-blue-700"
    onclick={submit}
  >
    Set Up
  </button>
</div>