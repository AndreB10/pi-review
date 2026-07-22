import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import piReviewExtension from "../src/index.js";
import { REVIEW_TOOL_NAMES } from "../src/review-agent.js";

describe("extension safety surface", () => {
  it("registers only /review and a report renderer, never a parent-agent tool", () => {
    const registerCommand = vi.fn();
    const registerMessageRenderer = vi.fn();
    const registerTool = vi.fn();
    const fakePi = { registerCommand, registerMessageRenderer, registerTool } as unknown as ExtensionAPI;

    piReviewExtension(fakePi);

    expect(registerCommand).toHaveBeenCalledTimes(1);
    expect(registerCommand).toHaveBeenCalledWith("review", expect.any(Object));
    expect(registerMessageRenderer).toHaveBeenCalledTimes(1);
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("exposes no shell or mutation tools to either internal reviewer", () => {
    expect(REVIEW_TOOL_NAMES).toEqual(["read_change", "read", "grep", "find", "ls"]);
    expect(REVIEW_TOOL_NAMES).not.toContain("bash");
    expect(REVIEW_TOOL_NAMES).not.toContain("edit");
    expect(REVIEW_TOOL_NAMES).not.toContain("write");
  });
});
