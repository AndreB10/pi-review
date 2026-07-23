import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown } from "@earendil-works/pi-tui";
import { captureChangeSnapshot, type GitExecutor } from "./git-snapshot.js";
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
  snapshot: ChangeSnapshot,
  reviewer: Model<any>,
  adversary: Model<any>,
  ctx: ExtensionCommandContext,
): Promise<boolean> {
  if (!ctx.hasUI) return true;
  const sensitive = snapshot.changes.filter((change) => change.sensitive).map((change) => change.path);
  const sensitiveText = sensitive.length
    ? `\n\nSensitive-looking changed paths:\n${sensitive.map((path) => `- ${path}`).join("\n")}`
    : "";
  return ctx.ui.confirm(
    "Send uncommitted code for review?",
    `${snapshot.changes.length} changed path${snapshot.changes.length === 1 ? "" : "s"} (${Math.ceil(snapshot.totalBytes / 1024)} KiB captured) will be available to:\n- Reviewer 1: ${modelKey(reviewer)}\n- Reviewer 2: ${modelKey(adversary)}${sensitiveText}\n\nThe extension is read-only, but both model providers will receive code and focused repository context.`,
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
): Promise<WorkflowResult> {
  const update = (stage: string, detail: string) => {
    ctx.ui.setStatus(STATUS_KEY, `${stage}: ${detail}`);
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

async function runWithProgress(
  ctx: ExtensionCommandContext,
  work: (signal?: AbortSignal) => Promise<WorkflowResult>,
): Promise<WorkflowResult | undefined> {
  if (ctx.mode !== "tui") return work(undefined);

  type Outcome = { result: WorkflowResult } | { error: unknown };
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
        const snapshot = await captureChangeSnapshot(ctx.cwd, git, undefined, reviewArguments.paths);
        if (snapshot.changes.length === 0) {
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
        if (!(await confirmDisclosure(snapshot, selected.reviewer, selected.adversary, ctx))) {
          notify(ctx, "Review cancelled.", "info");
          return;
        }

        const workflow = await runWithProgress(ctx, (signal) =>
          executeWorkflow(
            snapshot,
            reviewArguments.paths,
            selected.reviewer,
            selected.adversary,
            ctx,
            git,
            signal,
          ),
        );
        if (!workflow) {
          notify(ctx, "Review cancelled.", "info");
          return;
        }

        const markdown = buildReportMarkdown(workflow.details);
        pi.sendMessage({
          customType: MESSAGE_TYPE,
          content: markdown,
          display: true,
          details: workflow.details,
        });
        notify(
          ctx,
          workflow.details.adversary.error
            ? "Primary review completed, but the adversarial review failed."
            : "Two-stage code review completed.",
          workflow.details.adversary.error ? "warning" : "info",
        );
      } catch (error) {
        notify(ctx, errorMessage(error), "error");
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });
}
