import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface SelectedReviewModels {
  reviewer: Model<any>;
  adversary: Model<any>;
}

export function modelKey(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}

function parseArguments(args: string): string[] {
  const parts = args.trim() ? args.trim().split(/\s+/) : [];
  if (parts.length > 2) throw new Error("Usage: /review [reviewer-provider/model] [adversary-provider/model]");
  return parts;
}

function labelFor(model: Model<any>): string {
  const name = model.name && model.name !== model.id ? ` — ${model.name}` : "";
  return `${modelKey(model)}${name} (${Math.round(model.contextWindow / 1000)}k context)`;
}

async function chooseModel(
  title: string,
  supplied: string | undefined,
  models: Model<any>[],
  ctx: ExtensionCommandContext,
): Promise<Model<any> | undefined> {
  const byKey = new Map(models.map((model) => [modelKey(model), model]));
  if (supplied) {
    const model = byKey.get(supplied);
    if (!model) throw new Error(`Model ${JSON.stringify(supplied)} is not available or authenticated.`);
    return model;
  }
  if (!ctx.hasUI) throw new Error("Non-interactive review requires two explicit provider/model arguments.");

  const labels = models.map(labelFor);
  const byLabel = new Map(labels.map((label, index) => [label, models[index]]));
  const selected = await ctx.ui.select(title, labels);
  return selected ? byLabel.get(selected) : undefined;
}

export async function selectReviewModels(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<SelectedReviewModels | undefined> {
  const supplied = parseArguments(args);
  await ctx.modelRegistry.refresh();
  const currentKey = ctx.model ? modelKey(ctx.model) : undefined;
  const models = ctx.modelRegistry
    .getAvailable()
    .filter((model) => model.input.includes("text"))
    .sort((a, b) => {
      const aCurrent = modelKey(a) === currentKey ? 0 : 1;
      const bCurrent = modelKey(b) === currentKey ? 0 : 1;
      return aCurrent - bCurrent || modelKey(a).localeCompare(modelKey(b));
    });
  if (models.length === 0) throw new Error("No authenticated text models are available. Use /login first.");

  const reviewer = await chooseModel("Select Reviewer 1 model", supplied[0], models, ctx);
  if (!reviewer) return undefined;
  const adversary = await chooseModel("Select adversarial Reviewer 2 model", supplied[1], models, ctx);
  if (!adversary) return undefined;
  return { reviewer, adversary };
}
