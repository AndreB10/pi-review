import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureChangeSnapshot,
  captureRequestedChangeSnapshots,
  isSensitivePath,
  parsePorcelainV2,
  type GitExecutor,
} from "../src/git-snapshot.js";

const temporaryDirectories: string[] = [];

async function makeTemp(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-review-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const gitExecutor: GitExecutor = (args, cwd, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, signal, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await gitExecutor(args, cwd);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

async function initializeRepository(directory: string, withCommit = true): Promise<void> {
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Pi Review Tests");
  await git(directory, "config", "user.email", "tests@example.invalid");
  await git(directory, "config", "commit.gpgsign", "false");
  if (withCommit) {
    await writeFile(join(directory, "modified.ts"), "export const value = 1;\n");
    await writeFile(join(directory, "deleted.ts"), "export const removed = true;\n");
    await writeFile(join(directory, "rename.ts"), "export const renamed = true;\n");
    await git(directory, "add", ".");
    await git(directory, "commit", "-m", "initial");
  }
}

describe("parsePorcelainV2", () => {
  it("parses ordinary, renamed, conflicted, and untracked records with spaces", () => {
    const hash = "a".repeat(40);
    const output = [
      `1 .M N... 100644 100644 100644 ${hash} ${hash} path with spaces.ts`,
      `2 R. N... 100644 100644 100644 ${hash} ${hash} R100 renamed file.ts`,
      "old file.ts",
      `u UU N... 100644 100644 100644 100644 ${hash} ${hash} ${hash} conflict.ts`,
      "? untracked file.ts",
      "",
    ].join("\0");

    expect(parsePorcelainV2(output)).toEqual([
      {
        path: "path with spaces.ts",
        indexStatus: ".",
        worktreeStatus: "M",
        kind: "modified",
      },
      {
        path: "renamed file.ts",
        originalPath: "old file.ts",
        indexStatus: "R",
        worktreeStatus: ".",
        kind: "renamed",
      },
      {
        path: "conflict.ts",
        indexStatus: "U",
        worktreeStatus: "U",
        kind: "conflicted",
      },
      {
        path: "untracked file.ts",
        indexStatus: "?",
        worktreeStatus: "?",
        kind: "untracked",
      },
    ]);
  });
});

describe("captureChangeSnapshot", () => {
  it("captures staged, unstaged, untracked, renamed, and deleted changes without mutation", async () => {
    const directory = await makeTemp();
    await initializeRepository(directory);
    await writeFile(join(directory, "modified.ts"), "export const value = 2;\n");
    await writeFile(join(directory, "staged.ts"), "export const staged = true;\n");
    await git(directory, "add", "staged.ts");
    await writeFile(join(directory, "untracked file.ts"), "export const fresh = true;\n");
    await git(directory, "mv", "rename.ts", "renamed.ts");
    await rm(join(directory, "deleted.ts"));

    // Prime Git's index refresh before taking the byte-level invariant snapshot.
    const statusBefore = await git(directory, "status", "--porcelain=v2", "-z", "--untracked-files=all");
    const indexBefore = await readFile(join(directory, ".git", "index"));
    const modifiedBefore = await readFile(join(directory, "modified.ts"));

    const snapshot = await captureChangeSnapshot(directory, gitExecutor);

    expect(snapshot.changes.map((change) => change.path).sort()).toEqual(
      ["deleted.ts", "modified.ts", "renamed.ts", "staged.ts", "untracked file.ts"].sort(),
    );
    expect(snapshot.changes.find((change) => change.path === "modified.ts")?.content).toContain("+export const value = 2;");
    expect(snapshot.changes.find((change) => change.path === "deleted.ts")?.content).toContain("-export const removed");
    expect(snapshot.changes.find((change) => change.path === "untracked file.ts")?.contentKind).toBe("new-file");
    expect(snapshot.changes.find((change) => change.path === "renamed.ts")?.originalPath).toBe("rename.ts");
    expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);

    expect(await git(directory, "status", "--porcelain=v2", "-z", "--untracked-files=all")).toBe(statusBefore);
    expect(await readFile(join(directory, ".git", "index"))).toEqual(indexBefore);
    expect(await readFile(join(directory, "modified.ts"))).toEqual(modifiedBefore);
  });

  it("preserves both staged and unstaged layers even when the working tree reverts a staged change", async () => {
    const directory = await makeTemp();
    await initializeRepository(directory);
    await writeFile(join(directory, "modified.ts"), "export const value = 2;\n");
    await git(directory, "add", "modified.ts");
    await writeFile(join(directory, "modified.ts"), "export const value = 1;\n");

    const snapshot = await captureChangeSnapshot(directory, gitExecutor);
    const evidence = snapshot.changes.find((change) => change.path === "modified.ts")?.content ?? "";
    expect(evidence).toContain("STAGED CHANGES");
    expect(evidence).toContain("UNSTAGED CHANGES");
    expect(evidence).toContain("+export const value = 2;");
    expect(evidence).toContain("+export const value = 1;");
  });

  it("supports an unborn repository and records binary files and symlinks without following them", async () => {
    const directory = await makeTemp();
    await initializeRepository(directory, false);
    await writeFile(join(directory, "new.ts"), "export const newFile = true;\n");
    await git(directory, "add", "new.ts");
    await writeFile(join(directory, "new.ts"), "export const newFile = 'working tree';\n");
    await writeFile(join(directory, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    await symlink("/etc/passwd", join(directory, "link"));

    const snapshot = await captureChangeSnapshot(directory, gitExecutor);
    expect(snapshot.head).toBeNull();
    const newFileEvidence = snapshot.changes.find((change) => change.path === "new.ts")?.content ?? "";
    expect(newFileEvidence).toContain("STAGED CHANGES");
    expect(newFileEvidence).toContain("UNSTAGED CHANGES");
    expect(newFileEvidence).toContain("newFile");
    expect(snapshot.changes.find((change) => change.path === "binary.bin")?.contentKind).toBe("binary");
    expect(snapshot.changes.find((change) => change.path === "link")?.content).toBe("Symlink target: /etc/passwd");
  });

  it("works from a nested directory", async () => {
    const directory = await makeTemp();
    await initializeRepository(directory);
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src", "nested.ts"), "export {};\n");

    const snapshot = await captureChangeSnapshot(join(directory, "src"), gitExecutor);
    expect(snapshot.root).toBe(directory);
    expect(snapshot.changes.map((change) => change.path)).toContain("src/nested.ts");
  });

  it("scopes uncommitted changes and force-includes ignored files only for explicit paths", async () => {
    const directory = await makeTemp();
    await initializeRepository(directory);
    await mkdir(join(directory, "src"));
    await mkdir(join(directory, "other"));
    await mkdir(join(directory, "ignored output"));
    await writeFile(join(directory, ".gitignore"), "ignored output/\n");
    await writeFile(join(directory, "src", "changed.ts"), "export const scoped = 1;\n");
    await writeFile(join(directory, "src", "unchanged.ts"), "export const unchanged = true;\n");
    await writeFile(join(directory, "src", "deleted.ts"), "export const deleted = true;\n");
    await writeFile(join(directory, "other", "changed.ts"), "export const other = 1;\n");
    await git(directory, "add", ".");
    await git(directory, "commit", "-m", "add scoped fixtures");

    await writeFile(join(directory, "src", "changed.ts"), "export const scoped = 2;\n");
    await writeFile(join(directory, "src", "new.ts"), "export const fresh = true;\n");
    await rm(join(directory, "src", "deleted.ts"));
    await writeFile(join(directory, "other", "changed.ts"), "export const other = 2;\n");
    await writeFile(join(directory, "ignored output", "generated.ts"), "export const generated = 1;\n");

    const unscoped = await captureChangeSnapshot(directory, gitExecutor);
    expect(unscoped.changes.map((change) => change.path)).not.toContain("ignored output/generated.ts");

    const paths = ["src", "ignored output"];
    const snapshot = await captureChangeSnapshot(directory, gitExecutor, undefined, paths);
    expect(snapshot.changes.map((change) => change.path).sort()).toEqual(
      ["ignored output/generated.ts", "src/changed.ts", "src/deleted.ts", "src/new.ts"].sort(),
    );
    expect(snapshot.changes.map((change) => change.path)).not.toContain("src/unchanged.ts");
    expect(snapshot.changes.map((change) => change.path)).not.toContain("other/changed.ts");
    expect(snapshot.changes.find((change) => change.path === "ignored output/generated.ts")).toMatchObject({
      indexStatus: "!",
      worktreeStatus: "!",
      kind: "ignored",
      contentKind: "new-file",
    });

    await writeFile(join(directory, "other", "changed.ts"), "export const other = 3;\n");
    const unrelatedChange = await captureChangeSnapshot(directory, gitExecutor, undefined, paths);
    expect(unrelatedChange.fingerprint).toBe(snapshot.fingerprint);

    await writeFile(join(directory, "ignored output", "generated.ts"), "export const generated = 2;\n");
    const ignoredChange = await captureChangeSnapshot(directory, gitExecutor, undefined, paths);
    expect(ignoredChange.fingerprint).not.toBe(snapshot.fingerprint);
  });

  it("uses Git inside an existing child repository", async () => {
    const directory = await makeTemp();
    await initializeRepository(directory);
    const child = join(directory, "child");
    await mkdir(child);
    await initializeRepository(child);
    await git(directory, "add", "child");
    await git(directory, "commit", "-m", "add child repository");
    await writeFile(join(child, "modified.ts"), "export const value = 2;\n");

    const calls: Array<{ args: string[]; cwd: string }> = [];
    const recordingGit: GitExecutor = async (args, cwd, signal) => {
      calls.push({ args, cwd });
      return gitExecutor(args, cwd, signal);
    };
    const captured = await captureRequestedChangeSnapshots(directory, recordingGit, undefined, ["child"]);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.snapshot.root).toBe(child);
    expect(captured[0]?.scopePaths).toEqual(["."]);
    expect(captured[0]?.snapshot.changes.map((change) => change.path)).toEqual(["modified.ts"]);
    expect(calls).toContainEqual({ args: ["rev-parse", "--show-toplevel"], cwd: child });
    expect(calls.some((call) => call.cwd === child && call.args[0] === "status")).toBe(true);
  });

  it("uses a child repository even when its folder is ignored by the parent", async () => {
    const directory = await makeTemp();
    await initializeRepository(directory);
    await writeFile(join(directory, ".gitignore"), "ignored-repository/\n");
    await git(directory, "add", ".gitignore");
    await git(directory, "commit", "-m", "ignore child repository");
    const child = join(directory, "ignored-repository");
    await mkdir(child);
    await initializeRepository(child);
    await writeFile(join(child, "modified.ts"), "export const value = 2;\n");

    const captured = await captureRequestedChangeSnapshots(directory, gitExecutor, undefined, [
      "ignored-repository",
    ]);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.snapshot.root).toBe(child);
    expect(captured[0]?.snapshot.changes.map((change) => change.path)).toEqual(["modified.ts"]);
  });

  it("groups multiple existing folders by their own repositories", async () => {
    const workspace = await makeTemp();
    const first = join(workspace, "first");
    const second = join(workspace, "second");
    await mkdir(first);
    await mkdir(second);
    await initializeRepository(first);
    await initializeRepository(second);
    await writeFile(join(first, "modified.ts"), "export const value = 'first';\n");
    await writeFile(join(second, "modified.ts"), "export const value = 'second';\n");

    const captured = await captureRequestedChangeSnapshots(workspace, gitExecutor, undefined, ["first", "second"]);

    expect(captured.map((target) => target.snapshot.root).sort()).toEqual([first, second].sort());
    expect(captured.every((target) => target.scopePaths.length === 1 && target.scopePaths[0] === ".")).toBe(true);
    expect(captured.every((target) => target.snapshot.changes.some((change) => change.path === "modified.ts"))).toBe(
      true,
    );
  });

  it("uses the current path-scoped process for missing folders", async () => {
    const directory = await makeTemp();
    await initializeRepository(directory);
    await mkdir(join(directory, "removed-folder"));
    await writeFile(join(directory, "removed-folder", "gone.ts"), "export const gone = true;\n");
    await git(directory, "add", "removed-folder/gone.ts");
    await git(directory, "commit", "-m", "add removable folder");
    await rm(join(directory, "removed-folder"), { recursive: true });

    const captured = await captureRequestedChangeSnapshots(directory, gitExecutor, undefined, ["removed-folder"]);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.snapshot.root).toBe(directory);
    expect(captured[0]?.scopePaths).toEqual(["removed-folder"]);
    expect(captured[0]?.snapshot.changes.map((change) => change.path)).toEqual(["removed-folder/gone.ts"]);
  });

  it("force-includes files when an existing requested folder is ignored", async () => {
    const directory = await makeTemp();
    await initializeRepository(directory);
    await writeFile(join(directory, ".gitignore"), "ignored-folder/\n");
    await git(directory, "add", ".gitignore");
    await git(directory, "commit", "-m", "ignore generated folder");
    await mkdir(join(directory, "ignored-folder"));
    await writeFile(join(directory, "ignored-folder", "generated.ts"), "export const generated = true;\n");

    const captured = await captureRequestedChangeSnapshots(directory, gitExecutor, undefined, ["ignored-folder"]);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.snapshot.changes).toEqual([
      expect.objectContaining({
        path: "ignored-folder/generated.ts",
        indexStatus: "!",
        worktreeStatus: "!",
        kind: "ignored",
        contentKind: "new-file",
      }),
    ]);
  });

  it("rejects explicit review paths outside the repository and through escaping symlinks", async () => {
    const directory = await makeTemp();
    const outside = await makeTemp();
    await initializeRepository(directory);
    await symlink(outside, join(directory, "outside-link"));

    await expect(captureChangeSnapshot(directory, gitExecutor, undefined, ["../outside"])).rejects.toThrow(
      "outside the repository",
    );
    await expect(captureChangeSnapshot(directory, gitExecutor, undefined, ["outside-link"])).rejects.toThrow(
      "resolves outside the repository",
    );
    await expect(captureChangeSnapshot(directory, gitExecutor, undefined, [".git"])).rejects.toThrow(
      ".git internals",
    );
  });
});

describe("sensitive path detection", () => {
  it("flags likely secret-bearing files without matching ordinary names", () => {
    expect(isSensitivePath(".env.local")).toBe(true);
    expect(isSensitivePath("config/client-secret.json")).toBe(true);
    expect(isSensitivePath("certs/server.pem")).toBe(true);
    expect(isSensitivePath("src/monkey.ts")).toBe(false);
  });
});
