import { describe, expect, it } from "vitest";
import { parseReviewArguments, REVIEW_USAGE } from "../src/review-arguments.js";

describe("parseReviewArguments", () => {
  it("parses positional models and repeatable paths in any order", () => {
    expect(
      parseReviewArguments(
        'anthropic/claude-sonnet-4-6 --path src openai/gpt-5.4 --path "generated output" --path=fixtures',
      ),
    ).toEqual({
      modelIds: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4"],
      paths: ["src", "generated output", "fixtures"],
    });
  });

  it("supports escaped spaces in paths", () => {
    expect(parseReviewArguments("--path generated\\ output")).toEqual({
      modelIds: [],
      paths: ["generated output"],
    });
  });

  it("rejects malformed and unknown options with usage guidance", () => {
    for (const input of ["--path", "--path=", "--unknown value", "one two three", '--path "unfinished']) {
      expect(() => parseReviewArguments(input), input).toThrow(REVIEW_USAGE);
    }
  });
});
