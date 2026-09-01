<script lang="ts">
  let { onimport, ongenerate, onclose } = $props<{
    onimport: () => void;
    ongenerate: () => void;
    onclose: () => void;
  }>();
</script>

<div class="space-y-3">
  <button type="button" class="text-gray-500 hover:text-gray-900" onclick={onclose}>
    ← 鍵の管理に戻る
  </button>
  <h2 class="text-base font-medium">鍵を追加</h2>
  <button
    type="button"
    class="w-full rounded border border-gray-300 py-2 font-medium text-gray-700 hover:bg-gray-50"
    onclick={onimport}
  >
    鍵のインポート
  </button>
  <button
    type="button"
    class="w-full rounded bg-blue-600 py-2 font-medium text-white hover:bg-blue-700"
    onclick={ongenerate}
  >
    新しい鍵の生成
  </button>
</div>