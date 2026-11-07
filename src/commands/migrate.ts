import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Task } from "../model.js";
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
`;

/** Compare persisted task values, ignoring storage-only timestamps and absent fields. */
function fields(task: Task): unknown {
  const copy: Partial<Task> = { ...task };
  delete copy.deps;
  delete copy.updated;
  return JSON.parse(JSON.stringify(copy)) as unknown;
}

function compatible(source: Task, existing: Task): boolean {
  return (
    isDeepStrictEqual(fields(source), fields(existing)) &&
    existing.deps.every((dep, index) =>
      isDeepStrictEqual(dep, source.deps[index]),
    )
  );
}

export async function migrateCommand(rawArgs: string[]): Promise<string> {
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
  for (const task of tasks) {
    const targets = new Set<string>();
    for (const dep of task.deps) {
      if (!ids.has(dep.id) || dep.id === task.id) {
        throw new AxiError(
          `Invalid source dependency "${task.id}" -> "${dep.id}"`,
          "VALIDATION_ERROR",
        );
      }
      if (targets.has(dep.id)) {
        throw new AxiError(
          `Beads supports only one dependency per task pair: "${task.id}" -> "${dep.id}"`,
          "VALIDATION_ERROR",
        );
      }
      targets.add(dep.id);
    }
  }
  const remaining = new Map(tasks.map((task) => [task.id, task.deps.length]));
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dep of task.deps) {
      const next = dependents.get(dep.id) ?? [];
      next.push(task.id);
      dependents.set(dep.id, next);
    }
  }
  const ready = tasks
    .filter((task) => task.deps.length === 0)
    .map((task) => task.id);
  for (let i = 0; i < ready.length; i++) {
    for (const id of dependents.get(ready[i]) ?? []) {
      const count = remaining.get(id)! - 1;
      remaining.set(id, count);
      if (count === 0) ready.push(id);
    }
  }
  if (ready.length !== tasks.length)
    throw new AxiError(
      "Source dependency cycle must be resolved before migration",
      "VALIDATION_ERROR",
    );
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
  let created = 0;
  let dependenciesAdded = 0;
  const counts = { in_flight: 0, queued: 0, done: 0 };
  const ordered = [
    ...tasks.filter((task) => task.state === "in_flight").reverse(),
    ...tasks.filter((task) => task.state !== "in_flight"),
  ];
  for (const task of ordered) {
    counts[task.state]++;
    if (existing.has(task.id)) continue;
    await destination.store.create({
      ...task,
      created: task.created ?? null,
      deps: [],
    });
    created++;
  }
  for (const task of tasks) {
    for (const dep of task.deps) {
      if (await destination.store.addDep(task.id, dep)) dependenciesAdded++;
    }
  }
  if (destination.config.beadsMirrorPath) await destination.store.render?.();
  const result = {
    counts,
    created,
    existing: tasks.length - created,
    dependencies_added: dependenciesAdded,
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
