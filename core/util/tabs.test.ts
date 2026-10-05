import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { TabsManager } from "./tabs.js";

describe("TabsManager", () => {
  let tmpDir: string;
  let tabsFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "continue-tabs-test-"));
    tabsFile = path.join(tmpDir, "tabs.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty list when no tabs file exists", () => {
    const manager = new TabsManager(tabsFile);
    expect(manager.load("global")).toEqual([]);
  });

  it("saves and loads tabs for a given key", () => {
    const manager = new TabsManager(tabsFile);
    const tabs = [
      { id: "1", title: "Chat 1", isActive: true, sessionId: "s1" },
      { id: "2", title: "Chat 2", isActive: false, sessionId: "s2" },
    ];
    manager.save("global", tabs);
    expect(manager.load("global")).toEqual(tabs);
  });

  it("keeps different keys isolated (global vs local workspace)", () => {
    const manager = new TabsManager(tabsFile);
    manager.save("global", [
      { id: "g1", title: "Global", isActive: true, sessionId: "gs" },
    ]);
    manager.save("/abs/path/projectA", [
      { id: "a1", title: "Project A", isActive: true, sessionId: "as" },
    ]);

    expect(manager.load("global")).toHaveLength(1);
    expect(manager.load("global")[0].id).toBe("g1");
    expect(manager.load("/abs/path/projectA")).toHaveLength(1);
    expect(manager.load("/abs/path/projectA")[0].id).toBe("a1");
    // An unrelated workspace key has its own (empty) list.
    expect(manager.load("/abs/path/projectB")).toEqual([]);
  });

  it("overwrites the previous list for a key", () => {
    const manager = new TabsManager(tabsFile);
    manager.save("global", [{ id: "1", title: "A", isActive: true }]);
    manager.save("global", [
      { id: "2", title: "B", isActive: true },
      { id: "3", title: "C", isActive: false },
    ]);
    const loaded = manager.load("global");
    expect(loaded.map((t) => t.id)).toEqual(["2", "3"]);
  });

  it("restores tabs across instances sharing the same file (global scope)", () => {
    // Instance 1 opens three tabs and persists them.
    const instance1 = new TabsManager(tabsFile);
    instance1.save("global", [
      { id: "t1", title: "Chat 1", isActive: false, sessionId: "s1" },
      { id: "t2", title: "Chat 2", isActive: false, sessionId: "s2" },
      { id: "t3", title: "Chat 3", isActive: true, sessionId: "s3" },
    ]);

    // Instance 2 (separate manager, same file) restores the exact same tabs.
    const instance2 = new TabsManager(tabsFile);
    const restored = instance2.load("global");
    expect(restored.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(restored.find((t) => t.isActive)?.id).toBe("t3");
  });
});
