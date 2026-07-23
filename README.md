# @andre-barbosa/pi-review

A read-only [pi](https://pi.dev) extension that runs two sequential reviews over all uncommitted Git changes:

1. **Reviewer 1** finds concrete bugs, security vulnerabilities, and breaking changes.
2. **Reviewer 2** independently inspects the same snapshot and adversarially audits Reviewer 1 for false positives, incorrect severity, and missed issues.

The models are selected independently for every run. The extension never applies fixes.

## Install

From npm:

```bash
pi install npm:@andre-barbosa/pi-review
```

From Git:

```bash
pi install git:github.com/AndreB10/pi-review
```

For local development:

```bash
npm install
pi -e ./src/index.ts
```

When this repository is installed as a package, Pi discovers `src/index.ts` through the `pi.extensions` manifest in `package.json`.

## Usage

Run inside a Git working tree:

```text
/review
```

Pi prompts for the primary and adversarial models with compact, searchable selectors, then confirms which providers will receive the code. Type to fuzzy-filter by provider, model ID, or display name. Authenticated models from `ctx.modelRegistry` are available; use `/login` to add credentials.

Exact models may be supplied directly:

```text
/review anthropic/claude-sonnet-4-6 openai/gpt-5.4
```

Model IDs are `provider/model`, so IDs containing additional slashes—such as OpenRouter models—work as expected. In non-interactive modes, both model arguments are required.

Scope a review to uncommitted changes beneath one or more literal paths with repeatable `--path` options. Paths are repository-relative when Pi is inside a Git worktree and working-directory-relative otherwise:

```text
/review --path src --path "generated output"
/review anthropic/claude-sonnet-4-6 openai/gpt-5.4 --path packages/api
```

Explicit paths may name files or directories. For every existing directory, the extension resolves Git from inside that directory, so nested repositories and multiple repository folders are inspected with their own Git worktrees. Directories that resolve to the same repository are grouped; distinct repositories receive separate two-stage reports. Missing paths and files retain the current repository-relative path-scoped behavior.

Ignored directories are supported even when the directory itself is excluded by `.gitignore`: files beneath every explicit path are force-included as full current-file evidence, while unchanged tracked files remain excluded. When Pi is started outside a Git worktree, `/review --path <folder>` also works for existing folders that contain or belong to Git repositories.

## Review scope

The captured snapshot includes:

- staged changes (`HEAD` to index)
- unstaged changes (index to working tree)
- untracked, non-ignored files
- ignored files only beneath an explicit `--path`
- additions, modifications, deletions, renames, copies, and conflicts
- repositories without an initial commit

Without `--path`, all uncommitted changes in the current repository are reviewed and ignored files remain excluded. With `--path`, only uncommitted changes beneath the requested paths are included, using the repository discovered from within each existing directory. Binary contents are not sent through the immutable change tool; binary metadata is reported as a review limitation.

Each reviewer receives a fresh agent context with:

- immutable, paged access to every captured change
- repository-scoped `read`, `grep`, `find`, and `ls` tools for focused context
- no `bash`, `edit`, `write`, build, test, installation, or arbitrary extension tools

Filesystem tools reject paths outside the repository, symlinks escaping the repository, and `.git` internals. The source snapshot and model output are explicitly treated as untrusted data to reduce prompt-injection risk.

## Output

Each final custom message (one per distinct dirty repository) contains:

- snapshot identity and freshness
- Reviewer 1's complete report
- Reviewer 2's finding-by-finding adversarial verdict
- evidence-coverage warnings
- model IDs and usage information

Reports are persisted in Pi's session and participate in future context, but they do **not** trigger another model turn. You can inspect or copy them, ask an agent to fix selected findings later, or make changes manually.

## Read-only guarantee

`@andre-barbosa/pi-review` does not register a parent-agent tool and does not write repository files. It runs only fixed Git inspection commands and isolated agents with read-only tools. It also re-captures the working tree after review and marks the report stale if the snapshot changed while the reviewers were running.

Pi still persists the custom report in its normal session storage outside the repository.

## Privacy and limits

Both selected model providers receive the changed code and any focused repository context the reviewers read. Before requests begin, interactive users see the provider/model pair and warnings for sensitive-looking changed paths such as `.env`, private keys, or credential files.

A review is rejected rather than silently truncated when the captured evidence exceeds the extension's 10 MiB safety cap or cannot fit completely within either selected model's context window. Split very large change sets or choose larger-context models.

## Development

```bash
npm run typecheck
npm test
npm run check
```

The tests cover Git snapshot behavior, unborn repositories, staged and unstaged layers, path-scoped and ignored files, untracked and binary files, symlinks, path confinement, immutable evidence paging, context limits, adversarial handoff, report rendering, and repository invariance.
