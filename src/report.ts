import type { ReviewReportDetails, ReviewUsage } from "./types.js";

function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function usageLine(usage: ReviewUsage): string {
  const parts = [
    `${usage.turns} turn${usage.turns === 1 ? "" : "s"}`,
    `↑${formatTokens(usage.input)}`,
    `↓${formatTokens(usage.output)}`,
  ];
  if (usage.cacheRead) parts.push(`cache ${formatTokens(usage.cacheRead)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.join(" · ");
}

function coverageWarning(paths: string[] | undefined): string {
  if (!paths || paths.length === 0) return "";
  return `\n> **Coverage warning:** The reviewer did not fully consume immutable evidence for: ${paths.map((path) => `\`${path}\``).join(", ")}.\n`;
}

export function buildReportMarkdown(details: ReviewReportDetails): string {
  const stale = details.snapshot.stale
    ? "> **Stale snapshot:** The working tree changed while this review was running. Findings refer to the captured snapshot.\n\n"
    : "";
  const adversarySection = details.adversary.report
    ? `${coverageWarning(details.adversary.missingCoverage)}\n${details.adversary.report}\n\n_Usage: ${usageLine(details.adversary.usage!)}_`
    : `> **Reviewer 2 failed:** ${details.adversary.error ?? "Unknown error"}`;

  return `# Two-stage code review

${stale}**Repository:** \`${details.snapshot.root}\`

**Snapshot:** \`${details.snapshot.fingerprint.slice(0, 12)}\` · ${details.snapshot.changedFiles.length} changed path${details.snapshot.changedFiles.length === 1 ? "" : "s"} · base \`${details.snapshot.head?.slice(0, 12) ?? "unborn"}\`

## Reviewer 1 — ${details.reviewer.model}
${coverageWarning(details.reviewer.missingCoverage)}
${details.reviewer.report}

_Usage: ${usageLine(details.reviewer.usage)}_

---

## Reviewer 2 (adversarial) — ${details.adversary.model}
${adversarySection}
`;
}
