import { createAsyncThunk } from "@reduxjs/toolkit";
import { setTabs } from "../slices/tabsSlice";
import { ThunkApiType } from "../store";

/**
 * Resolve the persistence key for a given scope.
 * - "global" (or unset) -> "global" (shared across all projects/instances).
 * - "local" -> the active workspace key (isolated per project).
 */
function scopeKey(
  scope: "global" | "local" | undefined,
  activeWorkspaceKey: string,
): string {
  return scope === "local" ? activeWorkspaceKey : "global";
}

/**
 * Load persisted tabs for the given scope from core (tabs.json) and hydrate
 * the redux tabs state. Called once on startup, after the workspace key is set.
 */
export const loadPersistedTabs = createAsyncThunk<
  void,
  { scope: "global" | "local" | undefined },
  ThunkApiType
>("tabs/loadPersisted", async ({ scope }, { dispatch, getState, extra }) => {
  const key = scopeKey(scope, getState().tabs.activeWorkspaceKey);
  const result = await extra.ideMessenger.request("tabs/load", { key });
  if (result.status === "success") {
    dispatch(setTabs({ tabs: result.content.tabs, scope }));
  }
});

/**
 * Persist the current tab list for the given scope to core (tabs.json).
 * Called whenever tabs are opened/closed/renamed or the active tab changes.
 */
export const saveTabs = createAsyncThunk<
  void,
  { scope: "global" | "local" | undefined },
  ThunkApiType
>("tabs/save", async ({ scope }, { getState, extra }) => {
  const state = getState();
  const key = scopeKey(scope, state.tabs.activeWorkspaceKey);
  const tabs = state.tabs.tabsByWorkspace[key] ?? [];
  await extra.ideMessenger.request("tabs/save", { key, tabs });
});
