import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

function normalizeToolPath(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function validateProjectPath(root: string, value: string | undefined): Promise<void> {
  const input = normalizeToolPath(value || ".");
  const absolute = resolve(root, input);
  if (!isWithin(root, absolute)) throw new Error(`Path is outside the reviewed repository: ${JSON.stringify(value)}`);

  const rel = relative(root, absolute);
  if (rel === ".git" || rel.startsWith(`.git${sep}`)) {
    throw new Error("Reading .git internals is not allowed during review.");
  }

  try {
    const canonical = await realpath(absolute);
    if (!isWithin(root, canonical)) {
      throw new Error(`Path resolves outside the reviewed repository: ${JSON.stringify(value)}`);
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT") return;
    throw error;
  }
}
