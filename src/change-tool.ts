import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ChangeSnapshot } from "./types.js";

const DEFAULT_CHARS = 11_000;
const MAX_CHARS = 11_000;

const readChangeSchema = Type.Object({
  path: Type.String({ description: "Exact changed path from the review manifest" }),
  offset: Type.Optional(
    Type.Integer({ minimum: 0, description: "Character offset into the immutable evidence (default: 0)" }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_CHARS, description: `Maximum characters to return (max ${MAX_CHARS})` }),
  ),
});

interface Interval {
  start: number;
  end: number;
}

export class CoverageTracker {
  private readonly lengths = new Map<string, number>();
  private readonly intervals = new Map<string, Interval[]>();

  constructor(snapshot: ChangeSnapshot) {
    for (const change of snapshot.changes) this.lengths.set(change.path, Math.max(1, change.content.length));
  }

  mark(path: string, start: number, end: number): void {
    const existing = this.intervals.get(path) ?? [];
    existing.push({ start, end });
    existing.sort((a, b) => a.start - b.start);

    const merged: Interval[] = [];
    for (const interval of existing) {
      const previous = merged.at(-1);
      if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
      else merged.push({ ...interval });
    }
    this.intervals.set(path, merged);
  }

  isComplete(path: string): boolean {
    const length = this.lengths.get(path);
    if (length === undefined) return false;
    const ranges = this.intervals.get(path);
    return Boolean(ranges && ranges.length === 1 && ranges[0]?.start === 0 && (ranges[0]?.end ?? 0) >= length);
  }

  missingPaths(): string[] {
    return [...this.lengths.keys()].filter((path) => !this.isComplete(path));
  }
}

export interface ChangeToolBundle {
  tool: AgentTool<typeof readChangeSchema>;
  coverage: CoverageTracker;
}

export function createReadChangeTool(snapshot: ChangeSnapshot): ChangeToolBundle {
  const evidence = new Map(snapshot.changes.map((change) => [change.path, change]));
  const coverage = new CoverageTracker(snapshot);

  const tool: AgentTool<typeof readChangeSchema> = {
    name: "read_change",
    label: "Read change",
    description:
      "Read immutable captured evidence for one uncommitted path. Use the exact manifest path and keep calling with nextOffset until complete=true. This tool never accesses or changes the live working tree.",
    parameters: readChangeSchema,
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Review cancelled.");
      const change = evidence.get(params.path);
      if (!change) throw new Error(`Unknown changed path: ${JSON.stringify(params.path)}`);

      const source = change.content.length === 0 ? "(empty file)" : change.content;
      const offset = params.offset ?? 0;
      const limit = params.limit ?? DEFAULT_CHARS;
      if (offset >= source.length) {
        throw new Error(`Offset ${offset} is beyond the evidence length ${source.length} for ${JSON.stringify(params.path)}`);
      }

      const end = Math.min(source.length, offset + limit);
      const chunk = source.slice(offset, end);
      coverage.mark(change.path, offset, end);
      const complete = end >= source.length;
      const header = [
        `Path: ${JSON.stringify(change.path)}`,
        `Status: ${change.indexStatus}${change.worktreeStatus} (${change.kind}, ${change.contentKind})`,
        `Evidence characters: ${offset}-${end - 1} of ${source.length}`,
      ].join("\n");
      const footer = complete ? "End of evidence." : `Continue with offset=${end}.`;

      return {
        content: [{ type: "text", text: `${header}\n\n${chunk}\n\n${footer}` }],
        details: {
          path: change.path,
          offset,
          end,
          totalCharacters: source.length,
          nextOffset: complete ? undefined : end,
          complete,
        },
      };
    },
  };

  return { tool, coverage };
}
