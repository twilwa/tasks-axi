import { MarkdownStore } from "./backends/markdown.js";
import { BeadsStore } from "./backends/beads.js";
import {
  type ConfigOverrides,
  type ResolvedConfig,
  resolveConfig,
} from "./config.js";
import { AxiError } from "./errors.js";
import type { Store } from "./store.js";
import type { SuggestionGlobals } from "./suggestions.js";

/**
 * The resolved CLI context: the active backend Store plus the config that
 * selected it. The command layer only ever talks to `Store`, so swapping in
 * sqlite/remote backends (P2/P3) never touches arg parsing or rendering.
 */
export interface TasksContext {
  store: Store;
  config: ResolvedConfig;
  suggestionGlobals?: SuggestionGlobals;
}

/**
 * Build the Store a resolved config selects. Command code calls this instead of
 * constructing a backend directly, so a command that needs a second store (mv's
 * destination backlog) stays as backend-agnostic as the rest of the CLI layer.
 */
export function createStore(config: ResolvedConfig): Store {
  if (config.backend !== "markdown" && config.backend !== "beads") {
    throw new AxiError(
      `Unsupported backend "${config.backend}" — choose markdown or beads`,
      "UNSUPPORTED",
      ['Set `backend = "markdown"` or `backend = "beads"` in .tasks.toml'],
    );
  }

  return
    config.backend === "beads"
      ? new BeadsStore({
          path: config.path,
          binary: config.beadsBinary,
          prefix: config.beadsPrefix,
          timeoutMs: config.beadsTimeoutMs,
          mirrorPath: config.beadsMirrorPath,
          mirrorArchivePath: config.beadsMirrorArchivePath,
          doneKeep: config.doneKeep,
        })
      : new MarkdownStore({
          path: config.path,
          ...(config.archivePath ? { archivePath: config.archivePath } : {}),
        });
}

export function resolveTasksContext(
  overrides: ConfigOverrides = {},
  suggestionGlobals?: SuggestionGlobals,
): TasksContext {
  const config = resolveConfig(overrides);
  const store = createStore(config);
  return {
    store,
    config,
    ...(suggestionGlobals ? { suggestionGlobals } : {}),
  };
}

/** Narrow an optional context to a present one (the resolver always sets it). */
export function requireCtx(ctx: TasksContext | undefined): TasksContext {
  if (!ctx) {
    throw new AxiError("backlog context was not resolved", "UNKNOWN");
  }
  return ctx;
}
