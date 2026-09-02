<script lang="ts">
  import { onMount } from "svelte";

  let { onclose } = $props<{ onclose: () => void }>();

  let version = $state("0.0.0");

  onMount(() => {
    version = chrome.runtime.getManifest()?.version ?? "0.0.0";
  });
</script>

<div class="space-y-4">
  <button
    type="button"
    class="text-gray-500 hover:text-gray-900"
    onclick={onclose}
  >
    ← Back
  </button>

  <div class="flex items-center gap-2">
    <img src="icons/icon-32.png" alt="Dacci" class="h-8 w-8" />
    <div>
      <h2 class="text-base font-medium">Dacci</h2>
      <p class="text-xs text-gray-500">Nostr Signer</p>
    </div>
  </div>

  <dl class="space-y-2 text-sm">
    <div class="flex justify-between gap-4">
      <dt class="text-gray-500">Version</dt>
      <dd class="font-mono">{version}</dd>
    </div>
    <div class="flex justify-between gap-4">
      <dt class="text-gray-500">Author</dt>
      <dd>iqbqioza</dd>
    </div>
    <div class="flex justify-between gap-4">
      <dt class="text-gray-500">GitHub</dt>
      <dd>
        <a
          href="https://github.com/iqbqioza/dacci"
          target="_blank"
          rel="noreferrer"
          class="text-blue-600 hover:underline"
        >
          github.com/iqbqioza/dacci
        </a>
      </dd>
    </div>
  </dl>

  <div class="space-y-2 rounded border border-gray-300 p-3 text-sm text-gray-700">
    <p class="font-medium text-gray-900">Privacy</p>
    <p>No telemetry is collected.</p>
    <p>No data is sent anywhere. All operations happen locally in your browser.</p>
    <p>Your keys are encrypted and never leave this extension.</p>
  </div>
</div>