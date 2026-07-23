import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown } from "@earendil-works/pi-tui";
import {
  captureChangeSnapshot,
  captureRequestedChangeSnapshots,
  type CapturedChangeSnapshot,
  type GitExecutor,
} from "./git-snapshot.js";
import { modelKey, selectReviewModels } from "./model-selection.js";
import {
  ADVERSARY_SYSTEM_PROMPT,
  buildAdversaryPrompt,
  buildReviewerPrompt,
  REVIEWER_SYSTEM_PROMPT,
} from "./prompts.js";
import { buildReportMarkdown } from "./report.js";
import { parseReviewArguments } from "./review-arguments.js";
import { runReviewAgent } from "./review-agent.js";
import type { ChangeSnapshot, ReviewAgentResult, ReviewReportDetails } from "./types.js";

const MESSAGE_TYPE = "pi-review-report";
const STATUS_KEY = "pi-review";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  level: "info" | "warning" | "error",
): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else if (level !== "info") console.error(`[pi-review] ${message}`);
}

function createGitExecutor(pi: ExtensionAPI): GitExecutor {
  return async (args, cwd, signal) => {
    const execOptions = signal ? { cwd, signal, timeout: 60_000 } : { cwd, timeout: 60_000 };
    const result = await pi.exec("git", args, execOptions);
    return { stdout: result.stdout, stderr: result.stderr, code: result.code, killed: result.killed };
  };
}

function withLengthWarning(result: ReviewAgentResult): string {
  return result.stopReason === "length"
    ? `> **Output warning:** This model reached its output-token limit; the report may be incomplete.\n\n${result.text}`
    : result.text;
}

async function confirmDisclosure(
  snapshots: readonly ChangeSnapshot[],
  reviewer: Model<any>,
  adversary: Model<any>,
  ctx: ExtensionCommandContext,
): Promise<boolean> {
  if (!ctx.hasUI) return true;
  const changeCount = snapshots.reduce((total, snapshot) => total + snapshot.changes.length, 0);
  const totalBytes = snapshots.reduce((total, snapshot) => total + snapshot.totalBytes, 0);
  const sensitive = snapshots.flatMap((snapshot) =>
    snapshot.changes
      .filter((change) => change.sensitive)
      .map((change) => (snapshots.length === 1 ? change.path : `${snapshot.root}: ${change.path}`)),
  );
  const sensitiveText = sensitive.length
    ? `\n\nSensitive-looking changed paths:\n${sensitive.map((path) => `- ${path}`).join("\n")}`
    : "";
  const repositoryText =
    snapshots.length > 1
      ? `\n\nRepositories:\n${snapshots.map((snapshot) => `- ${snapshot.root}`).join("\n")}`
      : "";
  return ctx.ui.confirm(
    "Send uncommitted code for review?",
    `${changeCount} changed path${changeCount === 1 ? "" : "s"} (${Math.ceil(totalBytes / 1024)} KiB captured) will be available to:\n- Reviewer 1: ${modelKey(reviewer)}\n- Reviewer 2: ${modelKey(adversary)}${repositoryText}${sensitiveText}\n\nThe extension is read-only, but both model providers will receive code and focused repository context.`,
  );
}

interface WorkflowResult {
  details: ReviewReportDetails;
}

async function executeWorkflow(
  snapshot: ChangeSnapshot,
  reviewPaths: readonly string[],
  reviewerModel: Model<any>,
  adversaryModel: Model<any>,
  ctx: ExtensionCommandContext,
  git: GitExecutor,
  signal: AbortSignal | undefined,
  progressPrefix = "",
): Promise<WorkflowResult> {
  const update = (stage: string, detail: string) => {
    ctx.ui.setStatus(STATUS_KEY, `${progressPrefix}${stage}: ${detail}`);
  };

  update("Reviewer 1", "starting");
  const reviewer = await runReviewAgent({
    model: reviewerModel,
    modelRegistry: ctx.modelRegistry,
    snapshot,
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    prompt: buildReviewerPrompt(snapshot),
    ...(signal ? { signal } : {}),
    onPhase: (phase) => update("Reviewer 1", phase),
  });
  const reviewerReport = withLengthWarning(reviewer);

  let adversary: ReviewAgentResult | undefined;
  let adversaryError: string | undefined;
  try {
    update("Reviewer 2", "starting adversarial audit");
    adversary = await runReviewAgent({
      model: adversaryModel,
      modelRegistry: ctx.modelRegistry,
      snapshot,
      systemPrompt: ADVERSARY_SYSTEM_PROMPT,
      prompt: buildAdversaryPrompt(snapshot, reviewerReport),
      ...(signal ? { signal } : {}),
      onPhase: (phase) => update("Reviewer 2", phase),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    adversaryError = errorMessage(error);
  }

  update("Review", "checking snapshot freshness");
  let stale = true;
  try {
    const current = await captureChangeSnapshot(snapshot.root, git, signal, reviewPaths);
    stale = current.fingerprint !== snapshot.fingerprint;
  } catch {
    // If freshness cannot be proven, the report is conservatively marked stale.
  }

  const adversaryDetails: ReviewReportDetails["adversary"] = adversary
    ? {
        model: modelKey(adversaryModel),
        report: withLengthWarning(adversary),
        usage: adversary.usage,
        missingCoverage: adversary.missingCoverage,
      }
    : { model: modelKey(adversaryModel), error: adversaryError ?? "Unknown reviewer failure." };

  return {
    details: {
      snapshot: {
        root: snapshot.root,
        head: snapshot.head,
        fingerprint: snapshot.fingerprint,
        changedFiles: snapshot.changes.map((change) => change.path),
        totalBytes: snapshot.totalBytes,
        stale,
      },
      reviewer: {
        model: modelKey(reviewerModel),
        report: reviewerReport,
        usage: reviewer.usage,
        missingCoverage: reviewer.missingCoverage,
      },
      adversary: adversaryDetails,
      createdAt: Date.now(),
    },
  };
}

async function runWithProgress<T>(
  ctx: ExtensionCommandContext,
  work: (signal?: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  if (ctx.mode !== "tui") return work(undefined);

  type Outcome = { result: T } | { error: unknown };
  const outcome = await ctx.ui.custom<Outcome | null>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, "Running two-stage read-only code review...");
    let settled = false;
    const finish = (value: Outcome | null) => {
      if (settled) return;
      settled = true;
      done(value);
    };
    loader.onAbort = () => finish(null);
    work(loader.signal)
      .then((result) => finish({ result }))
      .catch((error) => finish({ error }));
    return loader;
  });

  if (outcome === null) return undefined;
  if ("error" in outcome) throw outcome.error;
  return outcome.result;
}

export default function piReviewExtension(pi: ExtensionAPI) {
  pi.registerMessageRenderer(MESSAGE_TYPE, (message, _options, theme) => {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part): part is { type: "text"; text: string } => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Markdown(content, 0, 0, getMarkdownTheme()));
    return box;
  });

  pi.registerCommand("review", {
    description: "Run a read-only primary and adversarial review of uncommitted changes",
    handler: async (args, ctx) => {
      const git = createGitExecutor(pi);
      try {
        const reviewArguments = parseReviewArguments(args);
        await ctx.waitForIdle();
        ctx.ui.setStatus(STATUS_KEY, "capturing uncommitted changes");
        const reviewTargets = (await captureRequestedChangeSnapshots(
          ctx.cwd,
          git,
          undefined,
          reviewArguments.paths,
        )).filter((target) => target.snapshot.changes.length > 0);
        if (reviewTargets.length === 0) {
          notify(
            ctx,
            reviewArguments.paths.length > 0
              ? "No uncommitted changes found under the requested paths."
              : "No staged, unstaged, or untracked changes to review.",
            "info",
          );
          return;
        }

        const selected = await selectReviewModels(reviewArguments.modelIds, ctx);
        if (!selected) {
          notify(ctx, "Review cancelled.", "info");
          return;
        }
        if (
          !(await confirmDisclosure(
            reviewTargets.map((target) => target.snapshot),
            selected.reviewer,
            selected.adversary,
            ctx,
          ))
        ) {
          notify(ctx, "Review cancelled.", "info");
          return;
        }

        const workflows = await runWithProgress(ctx, async (signal) => {
          const results: WorkflowResult[] = [];
          for (let index = 0; index < reviewTargets.length; index += 1) {
            if (signal?.aborted) throw new Error("Review cancelled.");
            const target: CapturedChangeSnapshot = reviewTargets[index]!;
            results.push(
              await executeWorkflow(
                target.snapshot,
                target.scopePaths,
                selected.reviewer,
                selected.adversary,
                ctx,
                git,
                signal,
                reviewTargets.length > 1 ? `Repository ${index + 1}/${reviewTargets.length} · ` : "",
              ),
            );
          }
          return results;
        });
        if (!workflows) {
          notify(ctx, "Review cancelled.", "info");
          return;
        }

        for (const workflow of workflows) {
          const markdown = buildReportMarkdown(workflow.details);
          pi.sendMessage({
            customType: MESSAGE_TYPE,
            content: markdown,
            display: true,
            details: workflow.details,
          });
        }

        const adversaryFailures = workflows.filter((workflow) => workflow.details.adversary.error).length;
        const multiple = workflows.length > 1;
        notify(
          ctx,
          adversaryFailures > 0
            ? multiple
              ? `${workflows.length} repository reviews completed; the adversarial review failed for ${adversaryFailures}.`
              : "Primary review completed, but the adversarial review failed."
            : multiple
              ? `${workflows.length} two-stage repository reviews completed.`
              : "Two-stage code review completed.",
          adversaryFailures > 0 ? "warning" : "info",
        );
      } catch (error) {
        notify(ctx, errorMessage(error), "error");
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });
}
