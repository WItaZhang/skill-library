import {
  lstat,
  readdir,
  readFile,
  realpath,
  mkdir,
  writeFile,
  rename,
  rm,
  cp,
  chmod,
} from "node:fs/promises";
import { resolve, join, dirname, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  DomainError,
  type Actor,
  type SkillContent,
} from "../../contracts/index.ts";
import type { ProductionLibraryService } from "../../contracts/production.ts";
import { validateContent, checksum } from "../persistence/content.ts";
import { createStore } from "../persistence/store.ts";

const media: Record<string, string> = {
  ".md": "text/markdown",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".py": "text/x-python",
  ".sh": "text/x-shellscript",
  ".js": "text/javascript",
  ".csv": "text/csv",
};
const ignored = new Set([".git", ".DS_Store", "__pycache__", "node_modules"]);
function fail(message: string): never {
  throw new DomainError("CONFLICT", message);
}

/** Never executes a skill. Reject unknown/binary files rather than silently dropping them. */
export async function readPackage(directory: string): Promise<SkillContent> {
  const files: SkillContent["files"] = [];
  let bytes = 0;
  async function walk(relative = "") {
    for (const entry of await readdir(join(directory, relative), {
      withFileTypes: true,
    })) {
      if (ignored.has(entry.name)) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail(`目录内含软链接，尚未导入：${path}`);
      if (
        entry.name.startsWith(".") ||
        /(?:^|\/)(?:credentials|secrets?)(?:\.|\/|$)/i.test(path)
      )
        fail(`目录内含隐藏文件或凭证文件，请先整理：${path}`);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) fail(`不支持的文件：${path}`);
      if (bytes > 2 * 1024 * 1024 || files.length >= 256)
        fail("技能文件过多或超过 2 MiB");
      const info = await lstat(join(directory, path));
      if (info.isSymbolicLink() || info.size + bytes > 2 * 1024 * 1024)
        fail(`文件过大或发生变化：${path}`);
      const buffer = await readFile(join(directory, path));
      bytes += buffer.length;
      let content: string;
      try {
        content = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(buffer);
      } catch {
        return fail(`暂不支持二进制文件：${path}`);
      }
      if (content.includes("\0")) fail(`暂不支持二进制文件：${path}`);
      files.push({
        path,
        content,
        mediaType: media[extname(path).toLowerCase()] ?? "text/plain",
      });
    }
  }
  await walk();
  return validateContent({ files });
}

function metadata(content: SkillContent, directory: string) {
  const main = content.files.find((f) => f.path === "SKILL.md")!.content;
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(main)?.[1] ?? "";
  function field(name: string) {
    const lines = front.split(/\r?\n/);
    const i = lines.findIndex((line) => line.startsWith(`${name}:`));
    if (i < 0) return "";
    const value = lines[i].slice(name.length + 1).trim();
    if (/^[>|][-+]?$/.test(value)) {
      const parts: string[] = [];
      for (const line of lines.slice(i + 1)) {
        if (line && !/^\s/.test(line)) break;
        parts.push(line.trim());
      }
      return parts.join(" ").trim();
    }
    return value.replace(/^(["'])([\s\S]*)\1$/, "$2");
  }
  return {
    name: (field("name") || basename(directory)).slice(0, 200),
    description: field("description").slice(0, 4000),
  };
}

export function createLocalFiles(options: {
  pool: Pool;
  library: ProductionLibraryService;
  actor: Actor;
  directories: string[];
  dataDir: string;
}) {
  const { pool, library, actor } = options;
  const store = createStore(pool);
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>) => {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  };
  async function allowed(directory: string) {
    const roots = await Promise.all(
      options.directories.map((p) => realpath(p).catch(() => undefined)),
    );
    if (!roots.includes(directory) || (await realpath(directory)) !== directory)
      fail("该目录不在本机连接配置中");
  }
  async function scan() {
    const seen = new Set<string>();
    const rows = [];
    for (const configured of options.directories) {
      try {
        const directory = await realpath(configured);
        if (seen.has(directory)) continue;
        seen.add(directory);
        const content = await readPackage(directory);
        const {
          rows: [source],
        } = await pool.query(
          "SELECT skill_id, baseline_checksum, synced_version_id FROM local_skill_sources WHERE team_id=$1 AND user_id=$2 AND source_path=$3",
          [actor.teamId, actor.userId, directory],
        );
        const skill = source
          ? await library.getSkill(actor, source.skill_id)
          : undefined;
        rows.push({
          directory,
          ...metadata(content, directory),
          files: content.files.length,
          skillId: skill?.id,
          checksum: checksum(content),
          status: !source
            ? "new"
            : checksum(content) !== source.baseline_checksum
              ? "external"
              : skill?.currentVersionId !== source.synced_version_id
                ? "published"
                : "synced",
        });
      } catch (error) {
        rows.push({
          directory: configured,
          name: basename(configured),
          status: "error",
          error: error instanceof Error ? error.message : "无法读取目录",
        });
      }
    }
    return rows;
  }
  function importDirectory(directory: string) {
    return serial(async () => {
      await allowed(directory);
      const content = await readPackage(directory);
      return store.transaction(actor, true, async (trusted) => {
        if (trusted.role !== "admin") fail("连接本机目录需要管理员权限");
        const {
          rows: [existing],
        } = await store.query(
          "SELECT skill_id FROM local_skill_sources WHERE team_id=$1 AND source_path=$2",
          [actor.teamId, directory],
        );
        if (existing)
          return { skillId: existing.skill_id, alreadyImported: true };
        const { skill, draft } = await library.createSkill(actor, {
          ...metadata(content, directory),
          maintainerIds: [],
          content,
        });
        const version = await library.publishDraft(actor, {
          draftId: draft.id,
          expectedRevision: draft.revision,
          expectedBaseVersionId: null,
          changeSummary: "从本机技能目录导入",
          idempotencyKey: randomUUID(),
        });
        await store.query(
          "INSERT INTO local_skill_sources(team_id,skill_id,user_id,source_path,baseline_checksum,synced_version_id) VALUES($1,$2,$3,$4,$5,$6)",
          [
            actor.teamId,
            skill.id,
            actor.userId,
            directory,
            checksum(content),
            version.id,
          ],
        );
        return { skillId: skill.id, alreadyImported: false };
      });
    });
  }
  function sync(skillId: string, versionId: string) {
    return serial(async () => {
      // Serialize publication and filesystem writes with the same team lock. A filesystem
      // commit followed by DB failure is safe: a retry recognizes the exact target digest.
      return store.transaction(actor, true, async (trusted) => {
        if (trusted.role !== "admin") fail("写回本机需要管理员权限");
        const {
          rows: [source],
        } = await store.query(
          "SELECT * FROM local_skill_sources WHERE team_id=$1 AND user_id=$2 AND skill_id=$3",
          [actor.teamId, actor.userId, skillId],
        );
        if (!source) fail("技能未连接本机目录");
        const directory = source.source_path;
        await allowed(directory);
        const skill = await library.getSkill(actor, skillId);
        if (skill.archivedAt || skill.currentVersionId !== versionId)
          fail("版本已变化，请刷新后选择最新已发布版本");
        const version = await library.getVersion(actor, versionId);
        validateContent(version.content);
        if (
          version.content.files.some((file) =>
            file.path
              .split("/")
              .some((part) => part.startsWith(".") || ignored.has(part)),
          )
        )
          fail("写回不支持隐藏文件或依赖目录");
        const current = await readPackage(directory);
        const before = checksum(current);
        if (before !== source.baseline_checksum && before !== version.checksum)
          fail(
            "本机文件已被其他工具修改。请先备份并处理差异，未覆盖任何文件。",
          );
        let backup: string | undefined;
        if (before !== version.checksum) {
          const id = randomUUID();
          backup = join(
            options.dataDir,
            "backups",
            `${basename(directory)}-${id}`,
          );
          const stage = join(dirname(directory), `.skill-library-stage-${id}`);
          const previous = join(
            dirname(directory),
            `.skill-library-previous-${id}`,
          );
          const journal = join(options.dataDir, "pending-sync.json");
          await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
          await cp(directory, backup, {
            recursive: true,
            dereference: false,
            errorOnExist: true,
            force: false,
          });
          // Keep ignored local metadata; replace only files managed by this package.
          await cp(directory, stage, {
            recursive: true,
            dereference: false,
            errorOnExist: true,
            force: false,
          });
          try {
            const desired = new Set(version.content.files.map((f) => f.path));
            for (const file of current.files)
              if (!desired.has(file.path)) await rm(join(stage, file.path));
            for (const file of version.content.files) {
              const target = join(stage, file.path);
              await mkdir(dirname(target), { recursive: true, mode: 0o700 });
              const originalMode = await lstat(target)
                .then((s) => s.mode & 0o777)
                .catch(() => 0o600);
              await writeFile(target, file.content, { mode: originalMode });
              await chmod(target, originalMode);
            }
            if (checksum(await readPackage(stage)) !== version.checksum)
              fail("写回校验失败，原目录未改动");
            if (checksum(await readPackage(directory)) !== before)
              fail("写回期间本机文件发生变化，原目录未改动");
            await writeFile(
              journal,
              JSON.stringify({ directory, stage, previous }),
              { mode: 0o600, flag: "wx" },
            );
            await rename(directory, previous);
            // Recheck the captured directory too, closing the usual rename race.
            if (checksum(await readPackage(previous)) !== before) {
              await rename(previous, directory);
              fail("本机文件发生变化，已保留修改");
            }
            try {
              await rename(stage, directory);
            } catch (error) {
              await rename(previous, directory);
              throw error;
            }
            // Retain the captured original as well: an editor may still hold it open.
            await rm(journal);
          } finally {
            await rm(stage, { recursive: true, force: true });
          }
        }
        await store.query(
          "UPDATE local_skill_sources SET baseline_checksum=$1,synced_version_id=$2 WHERE team_id=$3 AND skill_id=$4",
          [version.checksum, version.id, actor.teamId, skillId],
        );
        return { version: version.number, backup, directory };
      });
    });
  }
  function pull(skillId: string, expectedChecksum: string) {
    return serial(() =>
      store.transaction(actor, true, async (trusted) => {
        if (trusted.role !== "admin") fail("读取本机目录需要管理员权限");
        const {
          rows: [source],
        } = await store.query(
          "SELECT * FROM local_skill_sources WHERE team_id=$1 AND user_id=$2 AND skill_id=$3",
          [actor.teamId, actor.userId, skillId],
        );
        if (!source) fail("技能未连接本机目录");
        await allowed(source.source_path);
        const content = await readPackage(source.source_path);
        if (checksum(content) !== expectedChecksum)
          fail("文件再次变化，请刷新后重试");
        if (source.baseline_checksum === expectedChecksum)
          return { alreadyImported: true };
        const draft = await library.createDraft(actor, skillId);
        await library.saveDraft(actor, {
          draftId: draft.id,
          expectedRevision: draft.revision,
          content,
        });
        // Force the standard author-managed synchronization flow if both sides changed.
        await store.query(
          "UPDATE drafts SET data=jsonb_set(data,'{baseVersionId}',to_jsonb($1::text)) WHERE id=$2 AND team_id=$3",
          [source.synced_version_id, draft.id, actor.teamId],
        );
        await store.query(
          "UPDATE local_skill_sources SET baseline_checksum=$1 WHERE team_id=$2 AND skill_id=$3",
          [expectedChecksum, actor.teamId, skillId],
        );
        return { draftId: draft.id };
      }),
    );
  }
  return { scan, importDirectory, sync, pull };
}

/** Finish recovery before accepting any new write. Never discard a captured original. */
export async function recoverLocalSync(dataDir: string) {
  const path = join(dataDir, "pending-sync.json");
  let operation;
  try {
    operation = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const exists = (p: string) =>
    lstat(p).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
  if (!(await exists(operation.directory))) {
    if (!(await exists(operation.previous)))
      throw new Error("需要检查未完成写回的本机备份");
    await rename(operation.previous, operation.directory);
  }
  // Staging directories are retained on recovery for manual inspection.
  await rm(path);
}
