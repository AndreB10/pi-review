import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import type { ChangeEvidence, ChangeKind, ChangeSnapshot, StatusEntry } from "./types.js";

export const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export type GitExecutor = (args: string[], cwd: string, signal?: AbortSignal) => Promise<GitResult>;

function fieldSplit(record: string, fieldCountBeforePath: number): { fields: string[]; path: string } {
  const fields: string[] = [];
  let cursor = 0;
  for (let i = 0; i < fieldCountBeforePath; i += 1) {
    const next = record.indexOf(" ", cursor);
    if (next < 0) throw new Error(`Malformed git status record: ${JSON.stringify(record)}`);
    fields.push(record.slice(cursor, next));
    cursor = next + 1;
  }
  return { fields, path: record.slice(cursor) };
}

function changeKind(indexStatus: string, worktreeStatus: string, fallback: ChangeKind = "modified"): ChangeKind {
  const statuses = `${indexStatus}${worktreeStatus}`;
  if (statuses.includes("U") || statuses === "AA" || statuses === "DD") return "conflicted";
  if (statuses.includes("R")) return "renamed";
  if (statuses.includes("C")) return "copied";
  if (statuses.includes("D")) return "deleted";
  if (statuses.includes("A")) return "added";
  if (statuses.includes("M") || statuses.includes("T")) return "modified";
  return fallback;
}

/** Parse `git status --porcelain=v2 -z` without treating filenames as whitespace-delimited. */
export function parsePorcelainV2(output: string): StatusEntry[] {
  const records = output.split("\0");
  const entries: StatusEntry[] = [];

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;

    if (record.startsWith("1 ")) {
      const { fields, path } = fieldSplit(record, 8);
      const xy = fields[1] ?? "..";
      entries.push({
        path,
        indexStatus: xy[0] ?? ".",
        worktreeStatus: xy[1] ?? ".",
        kind: changeKind(xy[0] ?? ".", xy[1] ?? "."),
      });
      continue;
    }

    if (record.startsWith("2 ")) {
      const { fields, path } = fieldSplit(record, 9);
      const xy = fields[1] ?? "..";
      const originalPath = records[i + 1];
      if (originalPath === undefined) throw new Error(`Missing original path for rename: ${JSON.stringify(path)}`);
      i += 1;
      entries.push({
        path,
        originalPath,
        indexStatus: xy[0] ?? ".",
        worktreeStatus: xy[1] ?? ".",
        kind: changeKind(xy[0] ?? ".", xy[1] ?? "."),
      });
      continue;
    }

    if (record.startsWith("u ")) {
      const { fields, path } = fieldSplit(record, 10);
      const xy = fields[1] ?? "UU";
      entries.push({
        path,
        indexStatus: xy[0] ?? "U",
        worktreeStatus: xy[1] ?? "U",
        kind: "conflicted",
      });
      continue;
    }

    if (record.startsWith("? ")) {
      entries.push({
        path: record.slice(2),
        indexStatus: "?",
        worktreeStatus: "?",
        kind: "untracked",
      });
      continue;
    }

    // Ignored entries and optional header records are intentionally excluded.
    if (record.startsWith("! ") || record.startsWith("# ")) continue;
    throw new Error(`Unknown git status record: ${JSON.stringify(record)}`);
  }

  return entries;
}

export function isSensitivePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const file = basename(normalized);
  return (
    /^\.env(?:\..*)?$/i.test(file) ||
    /(?:^|[-_.])(secret|secrets|credential|credentials)(?:[-_.]|$)/i.test(file) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)$/i.test(file) ||
    /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(file)
  );
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertInsideRoot(root: string, candidate: string): string {
  const absolute = resolve(root, candidate);
  if (isWithinRoot(root, absolute)) return absolute;
  throw new Error(`Git reported a path outside the repository: ${JSON.stringify(candidate)}`);
}

async function normalizeScopePaths(root: string, requestedPaths: readonly string[]): Promise<string[]> {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const requestedPath of requestedPaths) {
    if (!requestedPath || requestedPath.includes("\0")) {
      throw new Error(`Invalid review path: ${JSON.stringify(requestedPath)}`);
    }

    const absolute = resolve(root, requestedPath);
    if (!isWithinRoot(root, absolute)) {
      throw new Error(`Review path is outside the repository: ${JSON.stringify(requestedPath)}`);
    }

    const rel = relative(root, absolute);
    if (rel === ".git" || rel.startsWith(`.git${sep}`)) {
      throw new Error("Reviewing .git internals is not allowed.");
    }

    // Resolve the nearest existing ancestor so a missing path cannot escape through
    // an existing symlink. Existing symlink scopes that resolve outside are rejected.
    let existing = absolute;
    while (true) {
      try {
        const canonical = await realpath(existing);
        if (!isWithinRoot(root, canonical)) {
          throw new Error(`Review path resolves outside the repository: ${JSON.stringify(requestedPath)}`);
        }
        break;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
        if (code !== "ENOENT") throw error;
        const parent = resolve(existing, "..");
        if (parent === existing) throw error;
        existing = parent;
      }
    }

    const gitPath = rel === "" ? "." : rel.split(sep).join("/");
    if (!seen.has(gitPath)) {
      seen.add(gitPath);
      normalized.push(gitPath);
    }
  }

  return normalized;
}

function isBinaryBuffer(buffer: Buffer): boolean {
  if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return false;
  } catch {
    return true;
  }
}

async function captureCurrentFile(root: string, entry: StatusEntry): Promise<ChangeEvidence> {
  const absolute = assertInsideRoot(root, entry.path);
  const stat = await lstat(absolute);
  let content: string;
  let contentKind: ChangeEvidence["contentKind"];

  if (stat.isSymbolicLink()) {
    content = `Symlink target: ${await readlink(absolute)}`;
    contentKind = "symlink";
  } else if (stat.isFile()) {
    const buffer = await readFile(absolute);
    if (isBinaryBuffer(buffer)) {
      content = `Binary file (${buffer.byteLength} bytes); content was not sent to reviewers.`;
      contentKind = "binary";
    } else {
      content = buffer.toString("utf8");
      contentKind = "new-file";
    }
  } else {
    content = `Unsupported uncommitted filesystem entry (${stat.isDirectory() ? "directory" : "special file"}).`;
    contentKind = "metadata";
  }

  return {
    ...entry,
    content,
    contentKind,
    byteLength: Buffer.byteLength(content),
    lineCount: content.length === 0 ? 0 : content.split("\n").length,
    sensitive: isSensitivePath(entry.path),
  };
}

async function captureTrackedPatch(
  root: string,
  head: string | null,
  entry: StatusEntry,
  git: GitExecutor,
  signal?: AbortSignal,
): Promise<ChangeEvidence> {
  const paths = entry.originalPath ? [entry.originalPath, entry.path] : [entry.path];
  for (const path of paths) assertInsideRoot(root, path);
  const literalPathspecs = paths.map((path) => `:(literal)${path}`);

  const common = [
    "--no-pager",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--full-index",
    "--find-renames",
    "--unified=40",
  ];
  const stagedArgs = [...common, "--cached", ...(head ? [head] : []), "--", ...literalPathspecs];
  const unstagedArgs = [...common, "--", ...literalPathspecs];
  const [staged, unstaged] = await Promise.all([
    git(stagedArgs, root, signal),
    git(unstagedArgs, root, signal),
  ]);
  for (const [layer, result] of [
    ["staged", staged],
    ["unstaged", unstaged],
  ] as const) {
    if (result.code !== 0) {
      throw new Error(
        `Unable to capture ${layer} diff for ${JSON.stringify(entry.path)}: ${result.stderr.trim() || `git exited ${result.code}`}`,
      );
    }
  }

  const sections: string[] = [];
  if (staged.stdout) sections.push(`=== STAGED CHANGES (HEAD -> INDEX) ===\n${staged.stdout}`);
  if (unstaged.stdout) sections.push(`=== UNSTAGED CHANGES (INDEX -> WORKTREE) ===\n${unstaged.stdout}`);
  const content = sections.join("\n") || `Status ${entry.indexStatus}${entry.worktreeStatus}; git produced no textual patch.`;
  const binary = /(?:Binary files .* differ|GIT binary patch)/.test(content);
  return {
    ...entry,
    content,
    contentKind: binary ? "binary" : sections.length > 0 ? "patch" : "metadata",
    byteLength: Buffer.byteLength(content),
    lineCount: content.length === 0 ? 0 : content.split("\n").length,
    sensitive: isSensitivePath(entry.path) || (entry.originalPath ? isSensitivePath(entry.originalPath) : false),
  };
}

function statusDisplay(entries: StatusEntry[]): string {
  return entries
    .map((entry) => {
      const move = entry.originalPath ? ` <- ${JSON.stringify(entry.originalPath)}` : "";
      return `${entry.indexStatus}${entry.worktreeStatus} ${JSON.stringify(entry.path)}${move}`;
    })
    .join("\n");
}

function snapshotFingerprint(head: string | null, statusText: string, changes: ChangeEvidence[]): string {
  const hash = createHash("sha256");
  hash.update(head ?? "<unborn>");
  hash.update("\0");
  hash.update(statusText);
  for (const change of changes) {
    hash.update("\0");
    hash.update(change.path);
    hash.update("\0");
    hash.update(change.originalPath ?? "");
    hash.update("\0");
    hash.update(change.content);
  }
  return hash.digest("hex");
}

export async function captureChangeSnapshot(
  cwd: string,
  git: GitExecutor,
  signal?: AbortSignal,
  requestedPaths: readonly string[] = [],
): Promise<ChangeSnapshot> {
  const rootResult = await git(["rev-parse", "--show-toplevel"], cwd, signal);
  if (rootResult.code !== 0) throw new Error("/review must be run inside a Git working tree.");
  const root = rootResult.stdout.trim();
  if (!root) throw new Error("Git returned an empty repository root.");

  // Resolve the repository itself, but do not resolve changed-file symlinks.
  const canonicalRoot = await realpath(root);
  const scopePaths = await normalizeScopePaths(canonicalRoot, requestedPaths);
  const literalPathspecs = scopePaths.map((path) => `:(literal)${path}`);
  const headResult = await git(["rev-parse", "--verify", "HEAD"], canonicalRoot, signal);
  const head = headResult.code === 0 ? headResult.stdout.trim() : null;

  const statusArgs = [
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
    ...(literalPathspecs.length > 0 ? ["--", ...literalPathspecs] : []),
  ];
  const statusResult = await git(statusArgs, canonicalRoot, signal);
  if (statusResult.code !== 0) {
    throw new Error(`Unable to inspect Git status: ${statusResult.stderr.trim() || `git exited ${statusResult.code}`}`);
  }

  const entries = parsePorcelainV2(statusResult.stdout);
  if (literalPathspecs.length > 0) {
    const ignoredResult = await git(
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...literalPathspecs],
      canonicalRoot,
      signal,
    );
    if (ignoredResult.code !== 0) {
      throw new Error(
        `Unable to inspect ignored files: ${ignoredResult.stderr.trim() || `git exited ${ignoredResult.code}`}`,
      );
    }

    const seenPaths = new Set(entries.map((entry) => entry.path));
    for (const path of ignoredResult.stdout.split("\0")) {
      if (!path || seenPaths.has(path)) continue;
      assertInsideRoot(canonicalRoot, path);
      entries.push({
        path,
        indexStatus: "!",
        worktreeStatus: "!",
        kind: "ignored",
      });
      seenPaths.add(path);
    }
  }

  const changes: ChangeEvidence[] = [];
  let totalBytes = 0;

  for (const entry of entries) {
    if (signal?.aborted) throw new Error("Review cancelled.");
    const evidence =
      entry.kind === "untracked" || entry.kind === "ignored"
        ? await captureCurrentFile(canonicalRoot, entry)
        : await captureTrackedPatch(canonicalRoot, head, entry, git, signal);

    totalBytes += evidence.byteLength;
    if (totalBytes > MAX_SNAPSHOT_BYTES) {
      throw new Error(
        `Uncommitted evidence exceeds the ${Math.round(MAX_SNAPSHOT_BYTES / 1024 / 1024)} MiB safety limit. Split the changes into smaller reviews.`,
      );
    }
    changes.push(evidence);
  }

  const statusText = statusDisplay(entries);
  return {
    root: canonicalRoot,
    head,
    capturedAt: Date.now(),
    statusText,
    changes,
    totalBytes,
    estimatedTokens: Math.ceil((totalBytes + Buffer.byteLength(statusText)) / 3),
    fingerprint: snapshotFingerprint(head, statusText, changes),
  };
}
