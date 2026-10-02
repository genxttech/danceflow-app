/**
 * SMS-A2P-3C: public studio profile tabs are chosen server-side from `?tab=`, and a URL
 * hash never reaches the server. A link such as `/studios/{slug}#lead` therefore rendered
 * the default tab with the target section hidden. This pure helper decides which tab must
 * be opened so a hash target is visible; the client tab bar applies it.
 *
 * Generic by design: each tab panel declares its tab with `data-studio-tab`, and any hash
 * that points inside a panel of another tab resolves to that panel's tab.
 */

export type StudioHashTarget = {
  /** Value of the `data-studio-tab` attribute on the panel containing the hash target. */
  panelTab: string | null;
};

/**
 * Returns the tab to switch to, or null when nothing should change (no hash, unknown
 * target, target not inside a tab panel, or its tab is already active).
 */
export function resolveDeepLinkTab(
  hash: string | null | undefined,
  activeTab: string,
  lookup: (id: string) => StudioHashTarget | null,
  validTabs: readonly string[],
): string | null {
  const id = decodeHashId(hash);
  if (!id) return null;

  const target = lookup(id);
  const panelTab = target?.panelTab ?? null;

  if (!panelTab || !validTabs.includes(panelTab) || panelTab === activeTab) return null;

  return panelTab;
}

export function decodeHashId(hash: string | null | undefined) {
  const raw = String(hash ?? "").replace(/^#/, "");
  if (!raw) return null;

  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
