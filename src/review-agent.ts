import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { convertToLlm, createReadOnlyTools, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createReadChangeTool } from "./change-tool.js";
import { validateProjectPath } from "./path-guard.js";
import { buildCoverageCorrectionPrompt } from "./prompts.js";
import { addUsage, emptyReviewUsage, type ChangeSnapshot, type ReviewAgentResult } from "./types.js";

const MAX_TURNS = 20;
export const REVIEW_TOOL_NAMES = ["read_change", "read", "grep", "find", "ls"] as const;
const ALLOWED_TOOLS = new Set<string>(REVIEW_TOOL_NAMES);

type PhaseUpdate = (message: string) => void;

function outputLimit(model: Model<any>): number {
  return Math.max(256, Math.min(8192, model.maxTokens, Math.floor(model.contextWindow * 0.15)));
}

export function assertReviewFitsContext(
  model: Model<any>,
  snapshot: ChangeSnapshot,
  systemPrompt: string,
  prompt: string,
): number {
  const maxOutput = outputLimit(model);
  const promptTokens = Math.ceil(Buffer.byteLength(`${systemPrompt}\n${prompt}`) / 3);
  const explorationReserve = Math.max(4_000, Math.floor(model.contextWindow * 0.1));
  const required = snapshot.estimatedTokens + promptTokens + maxOutput + explorationReserve;
  if (required > model.contextWindow) {
    throw new Error(
      `${model.provider}/${model.id} has a ${model.contextWindow.toLocaleString()} token context window, but a complete review is estimated to require ${required.toLocaleString()} tokens. Choose a larger-context model or split the changes.`,
    );
  }
  return maxOutput;
}

function lastAssistant(messages: readonly unknown[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string };
    if (message.role === "assistant") return messages[i] as AssistantMessage;
  }
  return undefined;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function safeOptions(
  options: SimpleStreamOptions | undefined,
  auth: {
    apiKey?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  },
  maxTokens: number,
  reasoning: boolean,
): SimpleStreamOptions {
  const result: SimpleStreamOptions = { ...options, maxTokens };
  if (reasoning) result.reasoning = "high";
  else delete result.reasoning;
  if (auth.apiKey !== undefined) result.apiKey = auth.apiKey;
  if (auth.headers !== undefined) result.headers = auth.headers;
  if (auth.env !== undefined) result.env = auth.env;
  return result;
}

export interface RunReviewAgentOptions {
  model: Model<any>;
  modelRegistry: ModelRegistry;
  snapshot: ChangeSnapshot;
  systemPrompt: string;
  prompt: string;
  signal?: AbortSignal;
  onPhase?: PhaseUpdate;
}

export async function runReviewAgent(options: RunReviewAgentOptions): Promise<ReviewAgentResult> {
  const { model, modelRegistry, snapshot, systemPrompt, prompt, signal, onPhase } = options;
  const maxTokens = assertReviewFitsContext(model, snapshot, systemPrompt, prompt);
  const provider = modelRegistry.getProvider(model.provider);
  if (!provider) throw new Error(`Provider ${JSON.stringify(model.provider)} is not available.`);
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);

  const { tool: readChange, coverage } = createReadChangeTool(snapshot);
  const repositoryTools = createReadOnlyTools(snapshot.root);
  const tools: AgentTool[] = [readChange, ...repositoryTools];
  const streamFn: StreamFn = (_requestedModel, context, streamOptions) =>
    provider.streamSimple(model, context, safeOptions(streamOptions, auth, maxTokens, model.reasoning));

  let turnCount = 0;
  let turnLimitReached = false;
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: model.reasoning ? "high" : "off",
      tools,
      messages: [],
    },
    convertToLlm,
    streamFn,
    toolExecution: "parallel",
    beforeToolCall: async ({ toolCall, args }) => {
      if (!ALLOWED_TOOLS.has(toolCall.name)) {
        return { block: true, reason: `${toolCall.name} is not allowed in read-only review mode.` };
      }
      if (toolCall.name === "read_change") return undefined;

      const path = args && typeof args === "object" && "path" in args ? (args as { path?: unknown }).path : undefined;
      try {
        await validateProjectPath(snapshot.root, typeof path === "string" ? path : undefined);
        return undefined;
      } catch (error) {
        return { block: true, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      const args = event.args as { path?: unknown };
      const suffix = typeof args?.path === "string" ? ` ${args.path}` : "";
      onPhase?.(`${toolLabel(event.toolName)}${suffix}`);
    }
    if (event.type === "turn_end") {
      turnCount += 1;
      if (
        turnCount >= MAX_TURNS &&
        event.message.role === "assistant" &&
        event.message.stopReason === "toolUse"
      ) {
        turnLimitReached = true;
        agent.abort();
      }
    }
  });

  const abortAgent = () => agent.abort();
  if (signal?.aborted) throw new Error("Review cancelled.");
  signal?.addEventListener("abort", abortAgent, { once: true });

  try {
    onPhase?.("analyzing captured changes");
    await agent.prompt(prompt);
    if (turnLimitReached) throw new Error(`Reviewer exceeded the ${MAX_TURNS}-turn safety limit.`);

    let missing = coverage.missingPaths();
    if (missing.length > 0 && !signal?.aborted && !turnLimitReached) {
      onPhase?.(`checking coverage for ${missing.length} path${missing.length === 1 ? "" : "s"}`);
      await agent.prompt(buildCoverageCorrectionPrompt(missing));
      if (turnLimitReached) throw new Error(`Reviewer exceeded the ${MAX_TURNS}-turn safety limit.`);
      missing = coverage.missingPaths();
    }

    const final = lastAssistant(agent.state.messages);
    if (!final) throw new Error("Reviewer returned no assistant response.");
    if (final.stopReason === "error") throw new Error(final.errorMessage || "Reviewer model failed.");
    if (final.stopReason === "aborted" || signal?.aborted) {
      throw new Error(turnLimitReached ? `Reviewer exceeded the ${MAX_TURNS}-turn safety limit.` : "Review cancelled.");
    }

    const text = assistantText(final);
    if (!text) throw new Error("Reviewer returned no textual report.");

    const usage = emptyReviewUsage();
    for (const message of agent.state.messages) {
      if (message.role === "assistant") addUsage(usage, message.usage);
    }

    return { text, usage, missingCoverage: missing, stopReason: final.stopReason };
  } finally {
    signal?.removeEventListener("abort", abortAgent);
    agent.abort();
  }
}

function toolLabel(toolName: string): string {
  switch (toolName) {
    case "read_change":
      return "reading change";
    case "read":
      return "reading context";
    case "grep":
      return "searching code";
    case "find":
      return "finding files";
    case "ls":
      return "listing files";
    default:
      return toolName;
  }
}
