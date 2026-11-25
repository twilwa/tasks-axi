import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  requireNonEmptySingleLineFlagValue,
  requirePositionals,
  takeBoolFlag,
  takeFlag,
} from "../args.js";
import { MarkdownStore } from "../backends/markdown.js";
import { resolveTasksContext } from "../context.js";
import { renderMutation } from "../confirm.js";
import { AxiError } from "../errors.js";
import { encode } from "@toon-format/toon";
import { checkImportGraph, compatible, writeTasks } from "../import.js";

export const MIGRATE_HELP = `usage: tasks-axi migrate --from markdown --to beads [flags]
flags:
  --from-file <path>  Override the configured markdown backlog
  --to-file <path>    Override the configured beads workspace/database
  --allow-existing   Resume/add to a non-empty destination; conflicting ids refuse
  --json             Machine-readable result
notes:
  Reads the configured backlog and Done archive without changing either.
  The destination must be empty unless --allow-existing is supplied.
  Reruns skip matching tasks and finish missing dependencies, never overwrite.
  Counts include archived Done tasks.
  elapsed_ms / ms_per_row report the run's wall time, per source row.
  An interrupted run resumes with --allow-existing; its lock clears itself.
`;

export async function migrateCommand(rawArgs: string[]): Promise<string> {
  const started = performance.now();
  const args = [...rawArgs];
  const from = takeFlag(args, "--from");
  const to = takeFlag(args, "--to");
  const fromFile = requireNonEmptySingleLineFlagValue(
    "--from-file",
    takeFlag(args, "--from-file"),
  );
  const toFile = requireNonEmptySingleLineFlagValue(
    "--to-file",
    takeFlag(args, "--to-file"),
  );
  const json = takeBoolFlag(args, "--json");
  const allowExisting = takeBoolFlag(args, "--allow-existing");
  requirePositionals(args, 0, 0, MIGRATE_HELP);
  if (from !== "markdown" || to !== "beads") {
    throw new AxiError(
      "Migration supports only --from markdown --to beads",
      "VALIDATION_ERROR",
    );
  }
  if (process.env.TASKS_AXI_FILE !== undefined) {
    throw new AxiError(
      "TASKS_AXI_FILE is ambiguous for migration; unset it and use --from-file/--to-file or backend-specific config",
      "VALIDATION_ERROR",
    );
  }
  const source = resolveTasksContext({ backend: from, file: fromFile });
  const archivePath =
    source.config.archivePath ??
    join(dirname(source.config.path), "done-archive.md");
  const destination = resolveTasksContext({ backend: to, file: toFile });
  if (!existsSync(source.config.path)) {
    throw new AxiError("Migration source backlog does not exist", "NOT_FOUND");
  }
  const archived = new MarkdownStore({ path: archivePath, archived: true });
  const tasks = [
    ...(await source.store.list({})).items,
    ...(await archived.list({})).items,
  ];
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id))
      throw new AxiError(`Duplicate source id "${task.id}"`, "CONFLICT");
    ids.add(task.id);
  }
  checkImportGraph(tasks);
  destination.store.validateImport?.(tasks, [source.config.path, archivePath]);
  const existing = new Map(
    (await destination.store.list({})).items.map((task) => [task.id, task]),
  );
  if (
    !allowExisting &&
    !(destination.store.isEmpty
      ? await destination.store.isEmpty()
      : existing.size === 0)
  ) {
    throw new AxiError(
      "Migration destination is not empty; use --allow-existing to resume without overwriting",
      "CONFLICT",
    );
  }
  for (const task of tasks) {
    const found = existing.get(task.id);
    if (found && !compatible(task, found)) {
      throw new AxiError(
        `Destination task "${task.id}" conflicts with the source; no tasks were imported`,
        "CONFLICT",
      );
    }
  }
  for (const state of ["in_flight", "queued", "done"] as const) {
    const desired = tasks
      .filter((task) => task.state === state)
      .map((task) => task.id);
    const present = [...existing.values()]
      .filter((task) => task.state === state && ids.has(task.id))
      .map((task) => task.id);
    const compatibleOrder =
      state === "in_flight"
        ? desired.slice(desired.length - present.length)
        : desired.slice(0, present.length);
    if (!isDeepStrictEqual(present, compatibleOrder))
      throw new AxiError(
        "Destination task order conflicts with resumable source order; no tasks were imported",
        "CONFLICT",
      );
  }
  const counts = { in_flight: 0, queued: 0, done: 0 };
  for (const task of tasks) counts[task.state]++;
  const written = await writeTasks(destination.store, tasks, existing);
  const created = written.created.length;
  const dependenciesAdded = written.dependenciesAdded;
  if (destination.config.beadsMirrorPath) await destination.store.render?.();
  const elapsed = performance.now() - started;
  const result = {
    counts,
    created,
    existing: tasks.length - created,
    dependencies_added: dependenciesAdded,
    elapsed_ms: Math.round(elapsed),
    // Over every source row, so a full run's figure extrapolates to N rows.
    ms_per_row: tasks.length ? Math.round(elapsed / tasks.length) : 0,
  };
  const already = created === 0 && dependenciesAdded === 0;
  return renderMutation({
    json,
    jsonPayload: {
      ok: true,
      action: "migrate",
      from,
      to,
      ...(already ? { already: true } : {}),
      ...result,
    },
    already,
    confirm: `migrate markdown -> beads (${tasks.length} tasks)`,
    detail: encode(result),
  });
}
