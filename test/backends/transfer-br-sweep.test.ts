import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BeadsStore } from "../../src/backends/beads.js";
import { moveRecordPath } from "../../src/backends/collection-transfer.js";
import { canonicalPath } from "../../src/backends/lock.js";
import { MarkdownStore } from "../../src/backends/markdown.js";
import { hasBr, makeBeadsWorkspace } from "../beads-helpers.js";

// Real br, every native call of a transfer: the call at index n either fails
// cleanly or times out while a descendant that kept the lock descriptor
// applies it late. Invariants of docs/collection-transfer.md must hold.
type Mode = "error" | "kill-late";
type Direction = "beads-to-markdown" | "markdown-to-beads";
const IDS = ["a", "b"];
const SEED =
  "# Backlog\n\n## In flight\n\n## Queued\n\n- [ ] a - Alpha\n- [ ] b - Beta blocked-by: a\n\n## Done\n";

function setup() {
  const ws = makeBeadsWorkspace();
  const br = execFileSync("bash", ["-c", "type -P br"]).toString().trim();
  const ctl = join(ws.dir, "ctl");
  mkdirSync(ctl, { recursive: true });
  const wrapper = join(ws.dir, "br-fault.sh");
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      `c='${ctl}'`,
      'if [ -e "$c/armed" ]; then',
      '  n=$(( $(cat "$c/count" 2>/dev/null || echo 0) + 1 )); echo $n > "$c/count"',
      '  if [ "$n" = "$(cat "$c/target" 2>/dev/null)" ]; then',
      '    case "$(cat "$c/mode")" in',
      `      kill-late) ( sleep 1.5; '${br}' "$@" >/dev/null 2>&1; touch "$c/finished" ) & exec sleep 30;;`,
      `      error) echo '{"error":{"code":"INJECTED","message":"injected failure"}}'; exit 1;;`,
      "    esac",
      "  fi",
      "fi",
      `exec '${br}' "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const md = join(ws.dir, "backlog.md");
  const stores = (binary?: string) => ({
    beads: new BeadsStore({ path: ws.path, binary, timeoutMs: 1_000 }),
    markdown: new MarkdownStore({ path: md }),
  });
  return { ws, ctl, wrapper, md, stores };
}

async function seed(env: ReturnType<typeof setup>, direction: Direction) {
  if (direction === "markdown-to-beads") {
    writeFileSync(env.md, SEED);
    await env.stores().beads.list({}); // initialize the empty database
  } else {
    const { beads } = env.stores();
    await beads.create({ id: "a", title: "Alpha" });
    await beads.create({
      id: "b",
      title: "Beta",
      deps: [{ type: "blocked-by", id: "a" }],
    });
    writeFileSync(
      env.md,
      "# Backlog\n\n## In flight\n\n## Queued\n\n## Done\n",
    );
  }
}

function move(
  env: ReturnType<typeof setup>,
  direction: Direction,
  binary?: string,
) {
  const { beads, markdown } = env.stores(binary);
  const [from, to] =
    direction === "beads-to-markdown" ? [beads, markdown] : [markdown, beads];
  return from.transferMany!(IDS, to).then(
    () => undefined,
    (error: unknown) => error,
  );
}

async function census(env: ReturnType<typeof setup>) {
  const { beads, markdown } = env.stores();
  const inBeads = new Set((await beads.list({})).items.map((t) => t.id));
  const inMd = new Set((await markdown.list({})).items.map((t) => t.id));
  return (id: string) =>
    [inBeads.has(id) && "beads", inMd.has(id) && "markdown"].filter(Boolean);
}

async function waitFor(path: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error("timed out waiting for " + path);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function callCount(direction: Direction): Promise<number> {
  const env = setup();
  try {
    await seed(env, direction);
    writeFileSync(join(env.ctl, "armed"), "");
    const error = await move(env, direction, env.wrapper);
    if (error) throw error;
    return Number(readFileSync(join(env.ctl, "count"), "utf8"));
  } finally {
    env.ws.cleanup();
  }
}

const DIRECTIONS: Direction[] = ["beads-to-markdown", "markdown-to-beads"];
const counts = hasBr
  ? Object.fromEntries(
      await Promise.all(DIRECTIONS.map(async (d) => [d, await callCount(d)])),
    )
  : {};
const cases = DIRECTIONS.flatMap((direction) =>
  Array.from({ length: counts[direction] ?? 0 }, (_, i) =>
    (["error", "kill-late"] as Mode[]).map((mode) => ({
      direction,
      call: i + 1,
      mode,
    })),
  ).flat(),
);

describe.skipIf(!hasBr)("transfer fault sweep over every real br call", () => {
  it("found the native calls of each direction", () => {
    for (const d of DIRECTIONS) expect(counts[d]).toBeGreaterThan(3);
  });

  it.concurrent.each(cases)(
    "$direction: br call $call fails with $mode",
    async ({ direction, call, mode }) => {
      const env = setup();
      try {
        await seed(env, direction);
        writeFileSync(join(env.ctl, "target"), String(call));
        writeFileSync(join(env.ctl, "mode"), mode);
        writeFileSync(join(env.ctl, "armed"), "");
        const error = await move(env, direction, env.wrapper);
        if (mode === "kill-late" && error)
          await waitFor(join(env.ctl, "finished"));
        const record = moveRecordPath(
          direction === "beads-to-markdown"
            ? canonicalPath(env.ws.path)
            : env.md,
        );
        const at = await census(env);
        for (const id of IDS) {
          expect(at(id).length, id + " lost").toBeGreaterThan(0);
          if (at(id).length === 2)
            expect(
              existsSync(record),
              id + " duplicated without a record",
            ).toBe(true);
        }
        // The rerun reconciles: every task only at the destination.
        const retry = await move(env, direction);
        expect(retry, String(retry)).toBeUndefined();
        const after = await census(env);
        const dest = direction === "beads-to-markdown" ? "markdown" : "beads";
        for (const id of IDS) expect(after(id)).toEqual([dest]);
        expect(existsSync(record)).toBe(false);
      } finally {
        env.ws.cleanup();
      }
    },
    60_000,
  );
});
