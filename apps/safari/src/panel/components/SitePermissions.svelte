<script lang="ts">
  import { onMount } from "svelte";
  import type { SitePermissionInfo } from "@dacci/core";
  import { sendPanelRequest } from "../api";

  let { keyId, onclose } = $props<{
    keyId: string;
    onclose: () => void;
  }>();

  let permissions = $state<SitePermissionInfo[]>([]);
  let error = $state("");
  let selectedSite = $state<string | null>(null);
  let confirmSiteKey = $state<string | null>(null);
  let deleting = $state(false);

  interface SiteGroup {
    site: string;
    kinds: SitePermissionInfo[];
  }

  function splitSiteKey(siteKey: string): { site: string; kind: string | null } {
    const idx = siteKey.lastIndexOf(":");
    if (idx === -1) {
      return { site: siteKey, kind: null };
    }
    const kind = siteKey.slice(idx + 1);
    if (!/^\d+$/.test(kind)) {
      return { site: siteKey, kind: null };
    }
    return { site: siteKey.slice(0, idx), kind };
  }

  let sites = $derived.by<SiteGroup[]>(() => {
    const map = new Map<string, SitePermissionInfo[]>();
    for (const permission of permissions) {
      const { site } = splitSiteKey(permission.siteKey);
      const kinds = map.get(site) ?? [];
      kinds.push(permission);
      map.set(site, kinds);
    }
    return [...map.entries()].map(([site, kinds]) => ({ site, kinds }));
  });

  let selectedKinds = $derived.by<SitePermissionInfo[]>(() => {
    if (!selectedSite) {
      return [];
    }
    return sites.find((group) => group.site === selectedSite)?.kinds ?? [];
  });

  onMount(async () => {
    await load();
  });

  async function load() {
    error = "";
    try {
      const res = await sendPanelRequest<{ type: "vault:sitePermissions"; permissions: SitePermissionInfo[] }>({
        type: "vault:getSitePermissions",
        keyId,
      });
      permissions = res.permissions;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function remove(siteKey: string) {
    deleting = true;
    error = "";
    try {
      const res = await sendPanelRequest<{ type: "vault:sitePermissions"; permissions: SitePermissionInfo[] }>({
        type: "vault:deleteSitePermission",
        keyId,
        siteKey,
      });
      permissions = res.permissions;
      confirmSiteKey = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      deleting = false;
    }
  }
</script>

{#if confirmSiteKey}
  <div class="space-y-3">
    <h2 class="text-base font-medium">許可を削除</h2>
    <p class="text-gray-600 dark:text-gray-300">
      「{confirmSiteKey}」の許可を削除しますか？<br />削除後は再び確認が表示されます。
    </p>
    {#if error}
      <p class="text-sm text-red-600">{error}</p>
    {/if}
    <button
      type="button"
      class="w-full rounded bg-red-600 py-2 font-medium text-white hover:bg-red-700 disabled:opacity-50"
      onclick={() => confirmSiteKey && remove(confirmSiteKey)}
      disabled={deleting}
    >
      削除
    </button>
    <button
      type="button"
      class="w-full rounded bg-gray-200 py-2 font-medium text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
      onclick={() => (confirmSiteKey = null)}
    >
      キャンセル
    </button>
  </div>
{:else if selectedSite}
  <div class="space-y-3">
    <button
      type="button"
      class="text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
      onclick={() => (selectedSite = null)}
    >
      ← サイト一覧に戻る
    </button>
    <h2 class="text-base font-medium">{selectedSite}</h2>
    {#if error}
      <p class="text-sm text-red-600">{error}</p>
    {/if}
    <ul class="space-y-2">
      {#each selectedKinds as permission (permission.siteKey)}
        <li>
          <div class="flex w-full items-center gap-2 rounded border border-gray-300 px-3 py-2 dark:border-gray-600">
            <div class="flex-1">
              <span class="block font-mono text-sm text-gray-700 dark:text-gray-200">
                {splitSiteKey(permission.siteKey).kind ? `kind: ${splitSiteKey(permission.siteKey).kind}` : permission.siteKey}
              </span>
              <span
                class="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium {permission.setting === 'allow'
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                  : 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'}"
              >
                {permission.setting === "allow" ? "許可" : "拒否"}
              </span>
            </div>
            <button
              type="button"
              title="許可を削除"
              class="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-400"
              onclick={() => (confirmSiteKey = permission.siteKey)}
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
                  d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"
                />
              </svg>
            </button>
          </div>
        </li>
      {/each}
      {#if selectedKinds.length === 0}
        <li class="text-gray-500 dark:text-gray-400">許可している kind はありません。</li>
      {/if}
    </ul>
  </div>
{:else}
  <div class="space-y-3">
    <button
      type="button"
      class="text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
      onclick={onclose}
    >
      ← 戻る
    </button>
    <h2 class="text-base font-medium">許可しているサイト</h2>
    {#if error}
      <p class="text-sm text-red-600">{error}</p>
    {/if}
    <ul class="space-y-2">
      {#each sites as group (group.site)}
        <li>
          <button
            type="button"
            class="flex w-full items-center rounded border border-gray-300 px-3 py-2 text-left hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800"
            onclick={() => (selectedSite = group.site)}
          >
            <span class="flex-1 break-all font-mono text-sm text-gray-700 dark:text-gray-200">{group.site}</span>
            <span class="ml-2 text-xs text-gray-400 dark:text-gray-500">{group.kinds.length} kind</span>
          </button>
        </li>
      {/each}
      {#if sites.length === 0}
        <li class="text-gray-500 dark:text-gray-400">許可しているサイトはありません。</li>
      {/if}
    </ul>
  </div>
{/if}