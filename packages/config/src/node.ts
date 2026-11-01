/** Loading `exclip.config.ts` from disk. Node only: apps/server, the apps' vite.config.ts and tests import this;
 * browser code never does. */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConfigError, resolveConfig, secretProblems, type Env, type ExclipConfig, type ExclipConfigInput, type ExclipSecrets } from "./index.ts";

export const CONFIG_FILE = "exclip.config.ts";
export const EXAMPLE_CONFIG_FILE = "exclip.config.example.ts";

/** The repository root: the nearest folder at or above `from` that holds pnpm-workspace.yaml. */
export function findRepoRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no pnpm-workspace.yaml at or above ${from}`);
    dir = parent;
  }
}

/** Where the configuration lives: EXCLIP_CONFIG when set (relative to the repository root), else exclip.config.ts at
 * the root. */
export function configPath(env: Env = process.env, root: string = findRepoRoot()): string {
  const override = env.EXCLIP_CONFIG?.trim();
  return override ? resolve(root, override) : join(root, CONFIG_FILE);
}

export type LoadedConfig = { config: ExclipConfig; secrets: ExclipSecrets; file: string | null };

/** What the server starts with: the configuration file read as readConfig does, and then the credentials its switched-on
 * features need (secretProblems), so a server with stocks on but no EXCLIP_EDGE_SECRET stops instead of starting. */
export async function loadExclipConfig(env: Env = process.env, root: string = findRepoRoot()): Promise<LoadedConfig> {
  const loaded = await readConfig(env, root);
  const problems = secretProblems(loaded.config, loaded.secrets);
  if (problems.length) throw new ConfigError(problems);
  return loaded;
}

/** The settings without the credentials, for the Vite configs: they bake a projection of these into a browser
 * bundle and have no use for a key, so a credential the server needs doesn't have to be set where the apps are built. */
export async function loadPublicConfig(env: Env = process.env, root: string = findRepoRoot()): Promise<ExclipConfig> {
  return (await readConfig(env, root)).config;
}

/** Imports the configuration file (Node 24 runs its TypeScript directly), applies the environment overrides and
 * validates the result. Without a file the defaults apply: no fee, no SODAX key, the placeholder origins. */
async function readConfig(env: Env, root: string): Promise<LoadedConfig> {
  const file = configPath(env, root);
  if (!existsSync(file)) {
    if (env.EXCLIP_CONFIG?.trim()) throw new ConfigError([`EXCLIP_CONFIG names ${file}, which does not exist`]);
    return { ...resolveConfig({}, env), file: null };
  }
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  if (mod.default === undefined) throw new ConfigError([`${file} must \`export default\` the configuration`]);
  return { ...resolveConfig(mod.default as ExclipConfigInput, env), file };
}
