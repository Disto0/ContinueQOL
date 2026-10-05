import { createSlice, PayloadAction } from "@reduxjs/toolkit";
import { getWorkspaceKey } from "../../util/workspaceKey";

export interface Tab {
  id: string;
  title: string;
  isActive: boolean;
  sessionId?: string;
}

interface TabsState {
  /**
   * Tabs are stored per workspace key. When `sessionTabsScope` is "local",
   * each project has its own tab list (keyed by workspace). When "global"
   * (default), all tabs are stored under the "global" key (legacy behavior).
   */
  tabsByWorkspace: Record<string, Tab[]>;
  /**
   * The workspace key currently active in this webview. Set on webview load
   * via `setActiveWorkspace(getWorkspaceKey())`.
   */
  activeWorkspaceKey: string;
}

function createInitialTab(): Tab {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).substring(2),
    title: "Chat 1",
    isActive: true,
  };
}

export const INITIAL_TABS_STATE: TabsState = {
  tabsByWorkspace: {},
  activeWorkspaceKey: "global",
};

/**
 * Resolve the effective key for tab operations based on the current scope.
 * - If scope is "local", use the active workspace key.
 * - If scope is "global" (or unset), use "global" (legacy behavior).
 */
function getEffectiveKey(state: TabsState, scope?: "global" | "local"): string {
  return scope === "local" ? state.activeWorkspaceKey : "global";
}

/**
 * Get the tab list for the effective key, initializing it if needed.
 */
function getTabsForKey(state: TabsState, key: string): Tab[] {
  if (!state.tabsByWorkspace[key]) {
    state.tabsByWorkspace[key] = [createInitialTab()];
  }
  return state.tabsByWorkspace[key];
}

export const tabsSlice = createSlice({
  name: "tabs",
  initialState: INITIAL_TABS_STATE,
  reducers: {
    /**
     * Set the active workspace key. Called on webview load so that tab
     * operations apply to the correct project's tab list when scope is "local".
     */
    setActiveWorkspace: (state, action: PayloadAction<string>) => {
      state.activeWorkspaceKey = action.payload;
    },
    setTabs: (
      state,
      action: PayloadAction<{ tabs: Tab[]; scope?: "global" | "local" }>,
    ) => {
      const key = getEffectiveKey(state, action.payload.scope);
      state.tabsByWorkspace[key] = action.payload.tabs;
    },
    updateTab: (
      state,
      action: PayloadAction<{
        id: string;
        updates: Partial<Tab>;
        scope?: "global" | "local";
      }>,
    ) => {
      const { id, updates, scope } = action.payload;
      const key = getEffectiveKey(state, scope);
      const tabs = getTabsForKey(state, key);
      state.tabsByWorkspace[key] = tabs.map((tab) =>
        tab.id === id ? { ...tab, ...updates } : tab,
      );
    },
    addTab: (
      state,
      action: PayloadAction<{ tab: Tab; scope?: "global" | "local" }>,
    ) => {
      const key = getEffectiveKey(state, action.payload.scope);
      const tabs = getTabsForKey(state, key);
      state.tabsByWorkspace[key] = tabs
        .map((tab) => ({
          ...tab,
          isActive: action.payload.tab.isActive ? false : tab.isActive,
        }))
        .concat(action.payload.tab);
    },
    removeTab: (
      state,
      action: PayloadAction<{ id: string; scope?: "global" | "local" }>,
    ) => {
      const key = getEffectiveKey(state, action.payload.scope);
      const tabs = getTabsForKey(state, key);
      state.tabsByWorkspace[key] = tabs.filter(
        (tab) => tab.id !== action.payload.id,
      );
    },
    setActiveTab: (
      state,
      action: PayloadAction<{ id: string; scope?: "global" | "local" }>,
    ) => {
      const key = getEffectiveKey(state, action.payload.scope);
      const tabs = getTabsForKey(state, key);
      state.tabsByWorkspace[key] = tabs.map((tab) => ({
        ...tab,
        isActive: tab.id === action.payload.id,
      }));
    },
    handleSessionChange: (
      state,
      action: PayloadAction<{
        currentSessionId: string;
        currentSessionTitle: string;
        newTabId?: string;
        scope?: "global" | "local";
      }>,
    ) => {
      const { currentSessionId, currentSessionTitle, newTabId, scope } =
        action.payload;
      const key = getEffectiveKey(state, scope);
      const tabs = getTabsForKey(state, key);

      const activeTab = tabs.find((tab) => tab.isActive);
      if (!activeTab) return;

      // Current session matches active tab's session
      if (activeTab.sessionId === currentSessionId) {
        state.tabsByWorkspace[key] = tabs.map((tab) =>
          tab.id === activeTab.id
            ? { ...tab, title: currentSessionTitle }
            : tab,
        );
        return;
      }

      // Check if there's another tab with the same session ID
      const existingTabWithSession = tabs.find(
        (tab) => tab.sessionId === currentSessionId,
      );
      if (existingTabWithSession) {
        // Activate the existing tab and update its title
        // Remove any unassigned tabs
        state.tabsByWorkspace[key] = tabs
          .filter(
            (tab) => tab.sessionId || tab.id === existingTabWithSession.id,
          )
          .map((tab) => ({
            ...tab,
            isActive: tab.id === existingTabWithSession.id,
            title:
              tab.sessionId === currentSessionId
                ? currentSessionTitle
                : tab.title,
          }));
        return;
      }

      // Active tab has no session ID
      if (!activeTab.sessionId) {
        state.tabsByWorkspace[key] = tabs.map((tab) =>
          tab.id === activeTab.id
            ? {
                ...tab,
                sessionId: currentSessionId,
                title: currentSessionTitle,
              }
            : tab,
        );
      } else {
        // Active tab has a session ID, create new tab
        state.tabsByWorkspace[key] = tabs
          .map((tab) => ({ ...tab, isActive: false }))
          .concat({
            id:
              newTabId ||
              Date.now().toString(36) + Math.random().toString(36).substring(2),
            title: currentSessionTitle,
            isActive: true,
            sessionId: currentSessionId,
          });
      }
    },
  },
  selectors: {
    /**
     * Selector for the tab list of the effective key (workspace or global).
     * Used by the UI (TabBar) so it always operates on the correct tab list.
     */
    selectActiveTabs: (state: TabsState): Tab[] => {
      // The scope is read from the config slice, but to avoid circular
      // dependencies, we default to "global" here. The TabBar component will
      // pass the scope explicitly when dispatching actions.
      const key = state.activeWorkspaceKey;
      const tabs = state.tabsByWorkspace[key];
      return tabs && tabs.length > 0 ? tabs : [createInitialTab()];
    },
  },
});

export const {
  setActiveWorkspace,
  setTabs,
  updateTab,
  addTab,
  removeTab,
  setActiveTab,
  handleSessionChange,
} = tabsSlice.actions;

export const { selectActiveTabs } = tabsSlice.selectors;

export default tabsSlice.reducer;
