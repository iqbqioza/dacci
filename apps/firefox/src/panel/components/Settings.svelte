<script lang="ts">
  import type { AppSettings } from "@dacci/core";
  import { sendPanelRequest } from "../api";
  import Dropdown from "./Dropdown.svelte";

  let { settings, onchange, onclose } = $props<{
    settings: AppSettings;
    onchange: (settings: AppSettings) => void;
    onclose: () => void;
  }>();

  const lockOptions: { value: string | number | null; label: string }[] = [
    { value: 1, label: "1 min" },
    { value: 5, label: "5 min" },
    { value: 15, label: "15 min" },
    { value: 30, label: "30 min" },
    { value: 60, label: "1 hour" },
    { value: 180, label: "3 hours" },
    { value: 360, label: "6 hours" },
    { value: 720, label: "12 hours" },
    { value: 1440, label: "1 day" },
    { value: null, label: "Never" },
  ];

  let currentPassphrase = $state("");
  let newPassphrase = $state("");
  let confirmPassphrase = $state("");
  let passError = $state("");
  let passSuccess = $state(false);
  let changing = $state(false);

  async function changePassphrase() {
    if (changing) {
      return;
    }
    passError = "";
    passSuccess = false;
    if (newPassphrase.length < 8) {
      passError = "New passphrase must be at least 8 characters";
      return;
    }
    if (newPassphrase !== confirmPassphrase) {
      passError = "Passphrases do not match";
      return;
    }
    changing = true;
    try {
      const res = await sendPanelRequest({
        type: "vault:changePassphrase",
        currentPassphrase,
        newPassphrase,
      });
      if (res.type === "vault:error") {
        passError = res.error;
      } else {
        currentPassphrase = "";
        newPassphrase = "";
        confirmPassphrase = "";
        passSuccess = true;
        setTimeout(() => (passSuccess = false), 3000);
      }
    } catch (e) {
      passError = e instanceof Error ? e.message : String(e);
    } finally {
      changing = false;
    }
  }
</script>

<div class="space-y-5">
  <button type="button" class="text-gray-500 hover:text-gray-900 " onclick={onclose}>
    ← Back
  </button>
  <h2 class="text-base font-medium">Settings</h2>

  <label class="block">
    <span class="mb-1 block text-xs text-gray-500 ">Lock Time</span>
    <Dropdown
      value={settings.autoLockMinutes}
      options={lockOptions}
      onselect={(value) => onchange({ ...settings, autoLockMinutes: value as number | null })}
    />
  </label>

  <div class="space-y-2 border-t border-gray-200 pt-4 ">
    <h3 class="text-sm font-medium text-gray-700 ">Change Passphrase</h3>
    <input
      type="password"
      bind:value={currentPassphrase}
      placeholder="Current passphrase"
      class="w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none   "
    />
    <input
      type="password"
      bind:value={newPassphrase}
      placeholder="New passphrase (8+ characters)"
      class="w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none   "
    />
    <input
      type="password"
      bind:value={confirmPassphrase}
      placeholder="Confirm passphrase"
      class="w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none   "
      onkeydown={(e) => {
        if (e.key === "Enter") changePassphrase();
      }}
    />
    {#if passError}
      <p class="text-sm text-red-600">{passError}</p>
    {/if}
    {#if passSuccess}
      <p class="text-sm text-green-700 ">Passphrase updated.</p>
    {/if}
    <button
      type="button"
      class="w-full rounded bg-blue-600 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      onclick={changePassphrase}
      disabled={changing}
    >
      Update Passphrase
    </button>
  </div>
</div>