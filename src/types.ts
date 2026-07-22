import type { Usage } from "@earendil-works/pi-ai";

export type ChangeKind = "added" | "modified" | "deleted" | "renamed" | "copied" | "conflicted" | "untracked";

export interface StatusEntry {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  kind: ChangeKind;
}

export interface ChangeEvidence extends StatusEntry {
  content: string;
  contentKind: "patch" | "new-file" | "symlink" | "binary" | "metadata";
  byteLength: number;
  lineCount: number;
  sensitive: boolean;
}

export interface ChangeSnapshot {
  root: string;
  head: string | null;
  capturedAt: number;
  statusText: string;
  changes: ChangeEvidence[];
  totalBytes: number;
  estimatedTokens: number;
  fingerprint: string;
}

export interface ReviewUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  turns: number;
}

export interface ReviewAgentResult {
  text: string;
  usage: ReviewUsage;
  missingCoverage: string[];
  stopReason: string;
}

export interface ReviewReportDetails {
  snapshot: {
    root: string;
    head: string | null;
    fingerprint: string;
    changedFiles: string[];
    totalBytes: number;
    stale: boolean;
  };
  reviewer: {
    model: string;
    report: string;
    usage: ReviewUsage;
    missingCoverage: string[];
  };
  adversary: {
    model: string;
    report?: string;
    usage?: ReviewUsage;
    missingCoverage?: string[];
    error?: string;
  };
  createdAt: number;
}

export function emptyReviewUsage(): ReviewUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 };
}

export function addUsage(total: ReviewUsage, usage: Usage): void {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens;
  total.cost += usage.cost.total;
  total.turns += 1;
}
