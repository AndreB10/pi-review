import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { validateProjectPath } from "../src/path-guard.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; outside: string }> {
  const parent = await mkdtemp(join(tmpdir(), "pi-review-path-"));
  temporaryDirectories.push(parent);
  const root = join(parent, "repo");
  const outside = join(parent, "outside.txt");
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "inside.ts"), "export {};\n");
  await writeFile(outside, "secret\n");
  await symlink(outside, join(root, "escape-link"));
  return { root, outside };
}

describe("validateProjectPath", () => {
  it("allows repository paths and a leading @", async () => {
    const { root } = await fixture();
    await expect(validateProjectPath(root, "inside.ts")).resolves.toBeUndefined();
    await expect(validateProjectPath(root, "@inside.ts")).resolves.toBeUndefined();
  });

  it("blocks traversal, .git internals, and symlinks escaping the repository", async () => {
    const { root, outside } = await fixture();
    await expect(validateProjectPath(root, "../outside.txt")).rejects.toThrow("outside");
    await expect(validateProjectPath(root, outside)).rejects.toThrow("outside");
    await expect(validateProjectPath(root, ".git/config")).rejects.toThrow(".git");
    await expect(validateProjectPath(root, "escape-link")).rejects.toThrow("resolves outside");
  });
});
