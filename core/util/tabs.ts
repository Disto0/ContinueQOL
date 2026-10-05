import * as fs from "fs";

import { SessionTab } from "../index.js";
import { getTabsFilePath } from "./paths.js";

/**
 * Persists open session tabs in a single global JSON file, keyed by scope.
 *
 * File shape: { "global": SessionTab[], "<workspaceKey>": SessionTab[] }
 * - "global" is used for the global tab scope (shared across projects).
 * - "<workspaceKey>" is used for the local scope (one entry per workspace).
 *
 * The GUI computes the key and sends it to core, so core does not need to
 * know about the current workspace.
 */
export class TabsManager {
  private readonly filePath: string;

  /**
   * @param filePath Optional explicit file path (used in tests to isolate from
   * the real ~/.continue/tabs.json). Defaults to the global tabs file.
   */
  constructor(filePath?: string) {
    this.filePath = filePath ?? getTabsFilePath();
  }

  private readAll(): Record<string, SessionTab[]> {
    const filepath = this.filePath;
    if (!fs.existsSync(filepath)) {
      return {};
    }
    try {
      const raw = fs.readFileSync(filepath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, SessionTab[]>;
      }
      return {};
    } catch (e) {
      console.warn(`Error reading tabs.json: ${e}`);
      return {};
    }
  }

  load(key: string): SessionTab[] {
    const all = this.readAll();
    const tabs = all[key];
    return Array.isArray(tabs) ? tabs : [];
  }

  save(key: string, tabs: SessionTab[]): void {
    const all = this.readAll();
    all[key] = tabs;
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(all, undefined, 2));
    } catch (e) {
      console.warn(`Error writing tabs.json: ${e}`);
    }
  }
}

const tabsManager = new TabsManager();

export default tabsManager;
