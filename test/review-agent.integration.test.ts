import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AssistantMessage, Context, Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { runReviewAgent } from "../src/review-agent.js";
import type { ChangeSnapshot } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const model: Model<any> = {
  id: "scripted",
  name: "Scripted",
  provider: "test",
  api: "openai-completions",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

function usage() {
  return {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test",
    model: "scripted",
    usage: usage(),
    stopReason,
    timestamp: Date.now(),
  };
}

function completedStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...message, content: [] } });
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } else {
      stream.push({ type: "done", reason: message.stopReason, message });
    }
  });
  return stream;
}

function snapshot(root: string): ChangeSnapshot {
  const content = "diff --git a/code.ts b/code.ts\n-old\n+new";
  return {
    root,
    head: "a".repeat(40),
    capturedAt: 1,
    statusText: ".M code.ts",
    changes: [
      {
        path: "code.ts",
        indexStatus: ".",
        worktreeStatus: "M",
        kind: "modified",
        content,
        contentKind: "patch",
        byteLength: Buffer.byteLength(content),
        lineCount: 3,
        sensitive: false,
      },
    ],
    totalBytes: Buffer.byteLength(content),
    estimatedTokens: 20,
    fingerprint: "f".repeat(64),
  };
}

describe("runReviewAgent", () => {
  it("executes only supplied read-only tools and leaves the repository unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-review-agent-"));
    temporaryDirectories.push(root);
    const codePath = join(root, "code.ts");
    await writeFile(codePath, "export const value = 'new';\n");
    const before = await readFile(codePath);

    let call = 0;
    const toolLists: string[][] = [];
    const provider = {
      id: "test",
      name: "Test",
      auth: {},
      getModels: () => [model],
      stream: (_model: Model<any>, _context: Context, _options?: unknown) => {
        throw new Error("Unexpected raw stream call");
      },
      streamSimple: (_model: Model<any>, context: Context, _options?: SimpleStreamOptions) => {
        toolLists.push((context.tools ?? []).map((tool) => tool.name));
        call += 1;
        if (call === 1) {
          // The model attempts a mutation tool that was never exposed. Agent core must turn it into an error result.
          return completedStream(
            assistant([{ type: "toolCall", id: "bad", name: "write", arguments: { path: "code.ts", content: "bad" } }], "toolUse"),
          );
        }
        if (call === 2) {
          return completedStream(
            assistant([{ type: "toolCall", id: "read", name: "read_change", arguments: { path: "code.ts" } }], "toolUse"),
          );
        }
        return completedStream(assistant([{ type: "text", text: "## Findings\nNo actionable findings." }], "stop"));
      },
    } as unknown as Provider;
    const registry = {
      getProvider: () => provider,
      getApiKeyAndHeaders: async () => ({ ok: true as const }),
    } as unknown as ModelRegistry;

    const result = await runReviewAgent({
      model,
      modelRegistry: registry,
      snapshot: snapshot(root),
      systemPrompt: "Read-only review",
      prompt: "Review everything",
    });

    expect(result.text).toContain("No actionable findings");
    expect(result.missingCoverage).toEqual([]);
    expect(toolLists.every((tools) => !tools.includes("write") && !tools.includes("edit") && !tools.includes("bash"))).toBe(true);
    expect(await readFile(codePath)).toEqual(before);
  });
});
