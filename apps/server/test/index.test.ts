/** index.ts as `pnpm dev` runs it, in a child process with the example configuration and memory storage: a port that's
 * already taken ends start-up with a message that says so and exit code 1, not the usual start-up lines. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

const INDEX = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** Runs index.ts with `args` and only the environment given, so a developer's exclip.config.ts, database or key can't
 * change the outcome. A server that starts anyway is killed after 10 s and fails the test instead of hanging it. */
async function run(env: Record<string, string>, args: string[]) {
  const child = spawn(process.execPath, [INDEX, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const [code] = (await once(child, "close")) as [number | null];
  clearTimeout(timer);
  return { code, stdout, stderr };
}

test("a port that's already taken: the server says so and exits with code 1", async (t) => {
  // Hold the port on every interface, as the server would listen on it.
  const holder = createServer();
  await new Promise<void>((resolve) => holder.listen(0, resolve));
  t.after(() => new Promise<void>((resolve) => holder.close(() => resolve())));
  const { port } = holder.address() as AddressInfo;

  const result = await run({ PORT: String(port), EXCLIP_CONFIG: "exclip.config.example.ts" }, ["--dev"]);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, new RegExp(`\\[exclip\\] can't listen on port ${port}: another process is using it\\. .*set PORT`));
  assert.doesNotMatch(result.stdout, /on port/, "no start-up lines");
});
