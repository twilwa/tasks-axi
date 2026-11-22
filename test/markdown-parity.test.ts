import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { type Outcome, runScenarios } from "../scripts/markdown-parity.js";

// Markdown must behave byte-for-byte and timing-for-timing as the pre-PR
// build. The fixture is scripts/markdown-parity.ts --json run against main's
// dist; regenerate it only from main, never from this branch.
const root = fileURLToPath(new URL("..", import.meta.url));
const tsx = pathToFileURL(
  join(root, "node_modules", "tsx", "dist", "loader.mjs"),
).href;
const fixture = JSON.parse(
  readFileSync(
    join(root, "test", "fixtures", "markdown-parity-main.json"),
    "utf8",
  ),
) as { results: Record<string, Outcome> };

describe("markdown parity with the pre-PR build", () => {
  it("matches main's exit codes, output, file bytes and lock waits", async () => {
    const actual = await runScenarios([
      "--import",
      tsx,
      join(root, "bin", "tasks-axi.ts"),
    ]);
    // Exact exit codes, output and file content. Waits are checked only from
    // below (no wall-clock upper bounds in CI); the two-sided timing check is
    // scripts/markdown-parity.ts run against main's dist, recorded in the PR.
    for (const [name, want] of Object.entries(fixture.results)) {
      const got = actual[name];
      expect(got, name).toBeDefined();
      expect({
        name,
        code: got!.code,
        out: got!.out,
        files: got!.files,
      }).toEqual({
        name,
        code: want.code,
        out: want.out,
        files: want.files,
      });
      if (want.waitMs > 0)
        expect(got!.waitMs, name + " wait").toBeGreaterThanOrEqual(
          want.waitMs - 300,
        );
    }
  }, 180_000);
});
