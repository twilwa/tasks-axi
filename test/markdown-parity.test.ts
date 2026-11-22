import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compare,
  type Outcome,
  runScenarios,
} from "../scripts/markdown-parity.js";

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
    expect(compare(fixture.results, actual, 400)).toEqual([]);
  }, 180_000);
});
