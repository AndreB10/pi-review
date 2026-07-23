import type { Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  filterReviewModels,
  modelKey,
  REVIEW_MODEL_SELECTOR_ROWS,
  ReviewModelSelector,
} from "../src/model-selection.js";

function model(id: string, name = id): Model<any> {
  return {
    id,
    name,
    provider: "test",
    api: "openai-completions",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const keybindings = {
  matches(data: string, keybinding: string): boolean {
    const keys: Record<string, string> = {
      "tui.select.up": "UP",
      "tui.select.down": "DOWN",
      "tui.select.pageUp": "PAGE_UP",
      "tui.select.pageDown": "PAGE_DOWN",
      "tui.select.confirm": "ENTER",
      "tui.select.cancel": "ESCAPE",
    };
    return data === keys[keybinding];
  },
};

function selector(models: Model<any>[], current: Model<any>, onSelect = vi.fn()) {
  return new ReviewModelSelector({
    title: "Select model",
    models,
    currentKey: modelKey(current),
    theme,
    keybindings,
    requestRender: vi.fn(),
    onSelect,
    onCancel: vi.fn(),
  });
}

describe("review model selector", () => {
  it("renders a compact scrolling window with the current model initially selected", () => {
    const models = Array.from({ length: 20 }, (_, index) => model(`model-${index}`, `Model ${index}`));
    const current = models[12]!;
    const component = selector(models, current);

    expect(component.getSelectedModel()).toBe(current);

    const lines = component.render(100);
    const modelLines = lines.filter((line) => line.includes("test/model-"));
    expect(modelLines).toHaveLength(REVIEW_MODEL_SELECTOR_ROWS);
    expect(modelLines.some((line) => line.includes("→ test/model-12 ✓"))).toBe(true);
    expect(lines.some((line) => line.includes("(13/20)"))).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
  });

  it("fuzzy-filters provider, model ID, and display name", () => {
    const sonnet = model("claude-sonnet-4-6", "Claude Sonnet 4.6");
    const models = [model("gpt-5.4", "GPT 5.4"), sonnet, model("gemini-3-pro", "Gemini 3 Pro")];

    expect(filterReviewModels(models, "snnt")).toEqual([sonnet]);
    expect(filterReviewModels(models, "test cld 46")).toEqual([sonnet]);
  });

  it("uses typed fuzzy search to select the best matching model", () => {
    const sonnet = model("claude-sonnet-4-6", "Claude Sonnet 4.6");
    const current = model("gpt-5.4", "GPT 5.4");
    const onSelect = vi.fn();
    const component = selector([current, model("gemini-3-pro", "Gemini 3 Pro"), sonnet], current, onSelect);

    for (const character of "snnt") component.handleInput(character);

    expect(component.getSelectedModel()).toBe(sonnet);
    component.handleInput("ENTER");
    expect(onSelect).toHaveBeenCalledWith(sonnet);
  });
});
