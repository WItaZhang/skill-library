import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { Actor } from "../contracts/index.ts";
export const dataDir =
  process.env.SKILL_LIBRARY_DATA_DIR ??
  join(homedir(), "Library", "Application Support", "Skill Library");
export interface LocalConfig {
  port: number;
  databasePort: number;
  databasePassword: string;
  accessKey: string;
  actor: Actor;
  displayName: string;
  directories: string[];
  pgBin: string;
}
export async function readConfig(): Promise<LocalConfig> {
  return JSON.parse(await readFile(join(dataDir, "config.json"), "utf8"));
}
export function connectionString(config: LocalConfig) {
  return `postgresql://skill_library:${encodeURIComponent(config.databasePassword)}@127.0.0.1:${config.databasePort}/skill_library`;
}
