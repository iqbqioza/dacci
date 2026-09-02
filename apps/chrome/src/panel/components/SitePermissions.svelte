<script lang="ts">
  import { onMount } from "svelte";
  import type { SitePermissionInfo } from "@signr/core";
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

  let allowedSites = $derived.by<SiteGroup[]>(() =>
    sites.filter((group) => group.kinds.some((kind) => kind.setting === "allow")),
  );

  let deniedSites = $derived.by<SiteGroup[]>(() =>
    sites.filter((group) => group.kinds.some((kind) => kind.setting === "deny")),
  );

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
    <h2 class="text-base font-medium">Remove Permission</h2>
    <p class="text-gray-600 ">
      Remove permission for "{confirmSiteKey}"?<br />You will be asked again afterwards.
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
      Delete
    </button>
    <button
      type="button"
      class="w-full rounded bg-gray-200 py-2 font-medium text-gray-700 hover:bg-gray-300  "
      onclick={() => (confirmSiteKey = null)}
    >
      Cancel
    </button>
  </div>
{:else if selectedSite}
  <div class="space-y-3">
    <button
      type="button"
      class="text-gray-500 hover:text-gray-900 "
      onclick={() => (selectedSite = null)}
    >
      ← Back to sites
    </button>
    <h2 class="text-base font-medium">{selectedSite}</h2>
    {#if error}
      <p class="text-sm text-red-600">{error}</p>
    {/if}
    <ul class="space-y-2">
      {#each selectedKinds as permission (permission.siteKey)}
        <li>
          <div class="flex w-full items-center gap-2 rounded border border-gray-300 px-3 py-2 ">
            <div class="flex-1">
              <span class="block font-mono text-sm text-gray-700 ">
                {splitSiteKey(permission.siteKey).kind ? `kind: ${splitSiteKey(permission.siteKey).kind}` : permission.siteKey}
              </span>
              <span
                class="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium {permission.setting === 'allow'
                  ? 'bg-blue-100 text-blue-700  '
                  : 'bg-red-100 text-red-700  '}"
              >
                {permission.setting === "allow" ? "Allow" : "Deny"}
              </span>
            </div>
            <button
              type="button"
              title="Remove Permission"
              class="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600"
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
        <li class="text-gray-500 ">No permissions for this site.</li>
      {/if}
    </ul>
  </div>
{:else}
  <div class="space-y-3">
    <button
      type="button"
      class="text-gray-500 hover:text-gray-900 "
      onclick={onclose}
    >
      ← Back
    </button>
    <h2 class="text-base font-medium">Site Permissions</h2>
    {#if error}
      <p class="text-sm text-red-600">{error}</p>
    {/if}

    <div>
      <h3 class="mb-2 text-sm font-medium text-gray-700 ">Allowed Sites</h3>
      <ul class="space-y-2">
        {#each allowedSites as group (group.site)}
          <li>
            <button
              type="button"
              class="flex w-full items-center rounded border border-gray-300 px-3 py-2 text-left hover:bg-gray-50 "
              onclick={() => (selectedSite = group.site)}
            >
              <span class="flex-1 break-all font-mono text-sm text-gray-700 ">{group.site}</span>
              <span class="ml-2 text-xs text-gray-400 ">{group.kinds.length} kind</span>
            </button>
          </li>
        {/each}
        {#if allowedSites.length === 0}
          <li class="text-gray-500 ">No allowed sites.</li>
        {/if}
      </ul>
    </div>

    <div class="border-t border-gray-200 pt-3 ">
      <h3 class="mb-2 text-sm font-medium text-gray-700 ">Denied Sites</h3>
      <ul class="space-y-2">
        {#each deniedSites as group (group.site)}
          <li>
            <button
              type="button"
              class="flex w-full items-center rounded border border-gray-300 px-3 py-2 text-left hover:bg-gray-50 "
              onclick={() => (selectedSite = group.site)}
            >
              <span class="flex-1 break-all font-mono text-sm text-gray-700 ">{group.site}</span>
              <span class="ml-2 text-xs text-gray-400 ">{group.kinds.length} kind</span>
            </button>
          </li>
        {/each}
        {#if deniedSites.length === 0}
          <li class="text-gray-500 ">No denied sites.</li>
        {/if}
      </ul>
    </div>
  </div>
{/if}