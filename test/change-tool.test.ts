import { describe, expect, it } from "vitest";
import { CoverageTracker, createReadChangeTool } from "../src/change-tool.js";
import type { ChangeEvidence, ChangeSnapshot } from "../src/types.js";

function change(path: string, content: string): ChangeEvidence {
  return {
    path,
    indexStatus: ".",
    worktreeStatus: "M",
    kind: "modified",
    content,
    contentKind: "patch",
    byteLength: Buffer.byteLength(content),
    lineCount: content.split("\n").length,
    sensitive: false,
  };
}

function snapshot(changes: ChangeEvidence[]): ChangeSnapshot {
  return {
    root: "/repo",
    head: "abc",
    capturedAt: 1,
    statusText: "",
    changes,
    totalBytes: changes.reduce((total, item) => total + item.byteLength, 0),
    estimatedTokens: 1,
    fingerprint: "f".repeat(64),
  };
}

describe("CoverageTracker", () => {
  it("merges ranges and reports incomplete paths", () => {
    const state = snapshot([change("a.ts", "abcdefghij"), change("b.ts", "xy")]);
    const tracker = new CoverageTracker(state);
    tracker.mark("a.ts", 5, 10);
    tracker.mark("a.ts", 0, 5);
    expect(tracker.isComplete("a.ts")).toBe(true);
    expect(tracker.missingPaths()).toEqual(["b.ts"]);
  });
});

describe("read_change", () => {
  it("returns immutable chunks and tracks complete coverage", async () => {
    const state = snapshot([change("a.ts", "0123456789")]);
    const { tool, coverage } = createReadChangeTool(state);

    const first = await tool.execute("1", { path: "a.ts", offset: 0, limit: 4 }, undefined, undefined);
    expect(first.content[0]).toMatchObject({ type: "text" });
    expect(first.content[0]?.type === "text" ? first.content[0].text : "").toContain("Continue with offset=4");
    expect(coverage.missingPaths()).toEqual(["a.ts"]);

    await tool.execute("2", { path: "a.ts", offset: 4, limit: 6 }, undefined, undefined);
    expect(coverage.missingPaths()).toEqual([]);
    expect(state.changes[0]?.content).toBe("0123456789");
  });

  it("rejects unknown paths and out-of-range offsets", async () => {
    const { tool } = createReadChangeTool(snapshot([change("a.ts", "abc")]));
    await expect(tool.execute("1", { path: "missing.ts" }, undefined, undefined)).rejects.toThrow("Unknown changed path");
    await expect(tool.execute("2", { path: "a.ts", offset: 99 }, undefined, undefined)).rejects.toThrow("beyond");
  });
});
