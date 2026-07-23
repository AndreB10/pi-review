import type { Model } from "@earendil-works/pi-ai";
import {
  DynamicBorder,
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  fuzzyFilter,
  Input,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";

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

export const REVIEW_MODEL_SELECTOR_ROWS = 8;

function modelSearchText(model: Model<any>): string {
  const name = model.name ? ` ${model.name}` : "";
  return `${model.provider} ${modelKey(model)} ${model.provider} ${model.id}${name}`;
}

export function filterReviewModels(models: readonly Model<any>[], query: string): Model<any>[] {
  return fuzzyFilter([...models], query, modelSearchText);
}

interface ReviewModelSelectorOptions {
  title: string;
  models: Model<any>[];
  currentKey: string | undefined;
  theme: Theme;
  keybindings: Pick<KeybindingsManager, "matches">;
  requestRender: () => void;
  onSelect: (model: Model<any>) => void;
  onCancel: () => void;
}

export class ReviewModelSelector extends Container implements Focusable {
  private readonly models: Model<any>[];
  private readonly currentKey: string | undefined;
  private readonly theme: Theme;
  private readonly keybindings: Pick<KeybindingsManager, "matches">;
  private readonly requestRender: () => void;
  private readonly onSelect: (model: Model<any>) => void;
  private readonly onCancel: () => void;
  private readonly searchInput = new Input();
  private readonly listContainer = new Container();
  private filteredModels: Model<any>[] = [];
  private selectedIndex = 0;
  private selectList: SelectList | undefined;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(options: ReviewModelSelectorOptions) {
    super();
    this.models = options.models;
    this.currentKey = options.currentKey;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.requestRender = options.requestRender;
    this.onSelect = options.onSelect;
    this.onCancel = options.onCancel;

    this.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
    this.addChild(new Text(this.theme.fg("accent", this.theme.bold(options.title)), 1, 0));
    this.addChild(new Text(this.theme.fg("dim", "Type to filter by provider, model, or name"), 1, 0));
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
    this.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));

    this.applyFilter("");
  }

  getSelectedModel(): Model<any> | undefined {
    return this.filteredModels[this.selectedIndex];
  }

  private applyFilter(query: string): void {
    this.filteredModels = filterReviewModels(this.models, query);
    const currentIndex = query.trim()
      ? -1
      : this.filteredModels.findIndex((model) => modelKey(model) === this.currentKey);
    this.selectedIndex = Math.max(0, currentIndex);
    this.rebuildList();
  }

  private rebuildList(): void {
    this.listContainer.clear();
    this.selectList = undefined;

    if (this.filteredModels.length === 0) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching models"), 0, 0));
      return;
    }

    const items: SelectItem[] = this.filteredModels.map((model) => {
      const current = modelKey(model) === this.currentKey ? " ✓" : "";
      const context = `${Math.round(model.contextWindow / 1000)}k context`;
      const description = model.name && model.name !== model.id ? `${model.name} · ${context}` : context;
      return { value: modelKey(model), label: `${modelKey(model)}${current}`, description };
    });
    const selectList = new SelectList(
      items,
      REVIEW_MODEL_SELECTOR_ROWS,
      {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("warning", text),
      },
      { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 48 },
    );
    selectList.setSelectedIndex(this.selectedIndex);
    this.selectList = selectList;
    this.listContainer.addChild(selectList);
  }

  private moveSelection(delta: number, wrap: boolean): void {
    if (this.filteredModels.length === 0) return;
    const next = this.selectedIndex + delta;
    this.selectedIndex = wrap
      ? (next + this.filteredModels.length) % this.filteredModels.length
      : Math.max(0, Math.min(next, this.filteredModels.length - 1));
    this.selectList?.setSelectedIndex(this.selectedIndex);
    this.requestRender();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onCancel();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1, true);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1, true);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.moveSelection(-REVIEW_MODEL_SELECTOR_ROWS, false);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.moveSelection(REVIEW_MODEL_SELECTOR_ROWS, false);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.getSelectedModel();
      if (selected) this.onSelect(selected);
      return;
    }

    const previousQuery = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    const query = this.searchInput.getValue();
    if (query !== previousQuery) this.applyFilter(query);
    this.requestRender();
  }
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

  if (ctx.mode === "tui") {
    return ctx.ui.custom<Model<any> | undefined>((tui, theme, keybindings, done) =>
      new ReviewModelSelector({
        title,
        models,
        currentKey: ctx.model ? modelKey(ctx.model) : undefined,
        theme,
        keybindings,
        requestRender: () => tui.requestRender(),
        onSelect: done,
        onCancel: () => done(undefined),
      }),
    );
  }

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
