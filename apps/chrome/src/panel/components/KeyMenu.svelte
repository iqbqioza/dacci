<script lang="ts">
  let { onimport, ongenerate, onclose } = $props<{
    onimport: () => void;
    ongenerate: () => void;
    onclose: () => void;
  }>();
</script>

<div class="space-y-3">
  <button
    type="button"
    class="text-gray-500 hover:text-gray-900 "
    onclick={onclose}
  >
    ← Back to keys
  </button>
  <h2 class="text-base font-medium">Add Key</h2>
  <button
    type="button"
    class="w-full rounded border border-gray-300 py-2 font-medium text-gray-700 hover:bg-gray-50   "
    onclick={onimport}
  >
    Import Key
  </button>
  <button
    type="button"
    class="w-full rounded bg-blue-600 py-2 font-medium text-white hover:bg-blue-700"
    onclick={ongenerate}
  >
    Generate New Key
  </button>
</div>