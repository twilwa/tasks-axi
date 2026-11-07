import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { canonicalPath, readFileSafe } from "./backends/lock.js";
import { AxiError } from "./errors.js";

/**
 * Backend + path resolution (report §8 config selection).
 *
 * Override order:
 *   --backend / --file flag > TASKS_AXI_* env > project .tasks.toml >
 *   ~/.tasks-axi/config.toml > defaults (markdown, first existing
 *   backlog.md/data/backlog.md, otherwise backlog.md).
 *
 * Markdown is the default. Beads requires an explicit workspace/database path;
 * it never relies on br's parent-directory workspace discovery.
 */

export interface ResolvedConfig {
  backend: string;
  /** Markdown backlog or beads workspace/.db file (absolute path). */
  path: string;
  /** Optional archive path for pruned tasks (resolved to an absolute path). */
  archivePath?: string;
  doneKeep: number;
  beadsBinary?: string;
  beadsPrefix?: string;
  beadsTimeoutMs?: number;
  beadsMirrorPath?: string;
  beadsMirrorArchivePath?: string;
}

export interface ConfigOverrides {
  backend?: string;
  file?: string;
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

interface TomlConfig {
  backend?: string;
  beads?: {
    path?: string;
    binary?: string;
    prefix?: string;
    timeout_ms?: number;
    mirror?: string;
    mirror_archive?: string;
  };
  markdown?: {
    path?: string;
    archive?: string;
    done_keep?: number;
  };
}

const DEFAULT_KEEP = 10;
const PATH_CANDIDATES = ["backlog.md", "data/backlog.md"];
type ConfigTable = "root" | "markdown" | "beads" | "unsupported";

/**
 * Minimal TOML reader for the tiny config surface we need: a top-level
 * `backend` key, `[beads]` connection/mirror settings, and `[markdown]` with
 * `path` / `archive` / `done_keep`.
 * `archive` points at the file that receives pruned tasks.
 * Intentionally not a general TOML parser.
 */
export function parseConfigToml(src: string): TomlConfig {
  const config: TomlConfig = {};
  let table: ConfigTable = "root";

  for (const rawLine of src.split("\n")) {
    const line = stripTomlComment(rawLine).trim();
    if (line === "") continue;

    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      const name = section[1].trim();
      table = name === "markdown" || name === "beads" ? name : "unsupported";
      continue;
    }

    if (table === "unsupported") continue;

    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!kv) {
      throw new AxiError(
        "Invalid config line: expected `key = value`",
        "VALIDATION_ERROR",
        ["Use `key = value` assignments in .tasks.toml"],
      );
    }
    const key = kv[1];
    const source = configKeySource(table, key);
    if (!source) continue;
    const value = parseTomlValue(kv[2], source);

    if (table === "root") {
      config.backend = requireTomlString(value, source);
      continue;
    }
    if (table === "beads") {
      config.beads ??= {};
      if (key === "path") config.beads.path = requireTomlString(value, source);
      if (key === "binary")
        config.beads.binary = requireTomlString(value, source);
      if (key === "prefix")
        config.beads.prefix = requireTomlString(value, source);
      if (key === "mirror")
        config.beads.mirror = requireTomlString(value, source);
      if (key === "mirror_archive")
        config.beads.mirror_archive = requireTomlString(value, source);
      if (key === "timeout_ms") {
        if (typeof value !== "number")
          throw new AxiError(
            "beads.timeout_ms must be an integer",
            "VALIDATION_ERROR",
          );
        config.beads.timeout_ms = value;
      }
      continue;
    }
    config.markdown ??= {};
    if (key === "path") config.markdown.path = requireTomlString(value, source);
    if (key === "archive")
      config.markdown.archive = requireTomlString(value, source);
    if (key === "done_keep") {
      if (typeof value !== "number") {
        throw new AxiError(
          "markdown.done_keep must be an integer",
          "VALIDATION_ERROR",
          ["Set `[markdown] done_keep = 10` in .tasks.toml"],
        );
      }
      config.markdown.done_keep = value;
    }
  }

  return config;
}

function stripTomlComment(raw: string): string {
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return raw.slice(0, i);
  }
  return raw;
}

function configKeySource(table: ConfigTable, key: string): string | undefined {
  if (table === "root" && key === "backend") return "backend";
  if (
    table === "beads" &&
    (key === "path" ||
      key === "binary" ||
      key === "prefix" ||
      key === "timeout_ms" ||
      key === "mirror" ||
      key === "mirror_archive")
  ) {
    return `beads.${key}`;
  }
  if (
    table === "markdown" &&
    (key === "path" || key === "archive" || key === "done_keep")
  ) {
    return `markdown.${key}`;
  }
  return undefined;
}

function parseTomlValue(raw: string, source: string): string | number {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    if (!trimmed.endsWith(quote) || trimmed.length === 1) {
      throw new AxiError(
        `${source} has an unterminated quoted value`,
        "VALIDATION_ERROR",
      );
    }
    return trimmed.slice(1, -1);
  }
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  throw new AxiError(`${source} has an invalid value`, "VALIDATION_ERROR");
}

function requireTomlString(value: string | number, source: string): string {
  if (typeof value === "string") return value;
  throw new AxiError(`${source} must be a quoted string`, "VALIDATION_ERROR");
}

function loadToml(path: string): TomlConfig {
  const src = readFileSafe(path);
  return src ? parseConfigToml(src) : {};
}

function resolveStorePath(
  explicit: string | undefined,
  tomlPath: string | undefined,
  cwd: string,
): string {
  const chosen = explicit ?? tomlPath;
  if (chosen) return isAbsolute(chosen) ? chosen : resolve(cwd, chosen);

  for (const candidate of PATH_CANDIDATES) {
    const full = resolve(cwd, candidate);
    if (existsSync(full)) return full;
  }
  return resolve(cwd, PATH_CANDIDATES[0]);
}

function beadsDatabasePath(path: string, cwd: string): string {
  const absolute = resolve(cwd, path);
  return canonicalPath(
    extname(absolute) === ".db" ? absolute : join(absolute, "beads.db"),
  );
}

function validatePathValue(
  value: string | undefined,
  source: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") {
    throw new AxiError(`${source} must not be empty`, "VALIDATION_ERROR", [
      "Set it to a backlog path or remove the empty override",
    ]);
  }
  return value;
}

function validateDoneKeep(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AxiError(
      "markdown.done_keep must be a non-negative integer",
      "VALIDATION_ERROR",
      ["Set `[markdown] done_keep = 10` in .tasks.toml"],
    );
  }
  return value;
}

export function resolveConfig(overrides: ConfigOverrides = {}): ResolvedConfig {
  const env = overrides.env ?? process.env;
  const cwd = overrides.cwd ?? process.cwd();
  const home = overrides.home ?? homedir();

  const homeToml = loadToml(join(home, ".tasks-axi", "config.toml"));
  const projectToml = loadToml(resolve(cwd, ".tasks.toml"));

  const backend =
    overrides.backend ??
    env.TASKS_AXI_BACKEND ??
    projectToml.backend ??
    homeToml.backend ??
    "markdown";
  const selectedTable = backend === "beads" ? "beads" : "markdown";

  const explicitPath =
    overrides.file !== undefined
      ? validatePathValue(overrides.file, "--file")
      : env.TASKS_AXI_FILE !== undefined
        ? validatePathValue(env.TASKS_AXI_FILE, "TASKS_AXI_FILE")
        : undefined;
  const tomlPath =
    explicitPath !== undefined
      ? undefined
      : backend === "beads" && env.TASKS_AXI_BEADS_PATH !== undefined
        ? validatePathValue(env.TASKS_AXI_BEADS_PATH, "TASKS_AXI_BEADS_PATH")
        : projectToml[selectedTable]?.path !== undefined
          ? validatePathValue(
              projectToml[selectedTable]?.path,
              `${selectedTable}.path`,
            )
          : validatePathValue(
              homeToml[selectedTable]?.path,
              `${selectedTable}.path`,
            );

  if (backend === "beads" && (explicitPath ?? tomlPath) === undefined) {
    throw new AxiError(
      "beads.path is required: select an explicit .beads directory or .db file",
      "VALIDATION_ERROR",
    );
  }
  const path = resolveStorePath(explicitPath, tomlPath, cwd);

  const archive =
    projectToml.markdown?.archive !== undefined
      ? validatePathValue(projectToml.markdown.archive, "markdown.archive")
      : validatePathValue(homeToml.markdown?.archive, "markdown.archive");
  const doneKeep = validateDoneKeep(
    projectToml.markdown?.done_keep ??
      homeToml.markdown?.done_keep ??
      DEFAULT_KEEP,
  );

  const config: ResolvedConfig = { backend, path, doneKeep };
  if (backend === "beads") {
    if (
      env.TASKS_AXI_BEADS_BINARY === undefined &&
      projectToml.beads?.binary !== undefined &&
      !["br", "bd"].includes(projectToml.beads.binary)
    ) {
      throw new AxiError(
        "project beads.binary must be the PATH name br or bd; use environment or home config for a trusted custom executable",
        "VALIDATION_ERROR",
      );
    }
    const binary =
      env.TASKS_AXI_BEADS_BINARY ??
      projectToml.beads?.binary ??
      homeToml.beads?.binary ??
      "br";
    validatePathValue(binary, "beads.binary");
    config.beadsBinary =
      binary.includes("/") || binary.includes("\\")
        ? resolve(cwd, binary)
        : binary;
    const timeout =
      env.TASKS_AXI_BEADS_TIMEOUT_MS !== undefined
        ? Number(env.TASKS_AXI_BEADS_TIMEOUT_MS)
        : (projectToml.beads?.timeout_ms ?? homeToml.beads?.timeout_ms);
    if (timeout !== undefined) {
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647)
        throw new AxiError(
          "beads.timeout_ms must be an integer between 1 and 2147483647",
          "VALIDATION_ERROR",
        );
      config.beadsTimeoutMs = timeout;
    }
    const mirror = validatePathValue(
      projectToml.beads?.mirror ?? homeToml.beads?.mirror,
      "beads.mirror",
    );
    const mirrorArchive = validatePathValue(
      projectToml.beads?.mirror_archive ?? homeToml.beads?.mirror_archive,
      "beads.mirror_archive",
    );
    const configuredDatabase =
      env.TASKS_AXI_BEADS_PATH ??
      projectToml.beads?.path ??
      homeToml.beads?.path;
    // Mirrors belong to the configured database, not a peer selected by --file
    // or mv --to. Directory/file spellings and symlink aliases share ownership.
    if (
      (mirror || mirrorArchive) &&
      configuredDatabase &&
      beadsDatabasePath(path, cwd) ===
        beadsDatabasePath(configuredDatabase, cwd)
    ) {
      if (mirror) config.beadsMirrorPath = resolve(cwd, mirror);
      if (mirrorArchive)
        config.beadsMirrorArchivePath = resolve(cwd, mirrorArchive);
    }
    config.beadsPrefix = validatePathValue(
      env.TASKS_AXI_BEADS_PREFIX ??
        projectToml.beads?.prefix ??
        homeToml.beads?.prefix,
      "beads.prefix",
    );
  }
  if (archive) {
    config.archivePath = isAbsolute(archive) ? archive : resolve(cwd, archive);
  }
  return config;
}
