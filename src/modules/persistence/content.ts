import { createHash } from "node:crypto";
import { posix } from "node:path";
import { diffArrays } from "diff";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
});
import {
  DomainError,
  type SkillContent,
  type SkillFile,
  type MergeConflict,
  type FileDiff,
} from "../../contracts/index.ts";

export const fail = (
  code: ConstructorParameters<typeof DomainError>[0],
  message: string,
  details?: unknown,
): never => {
  throw new DomainError(code, message, details);
};
export function nonempty(
  value: unknown,
  field: string,
  max = 1000,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  )
    fail("VALIDATION", `${field}不能为空且不能超过${max}个字符`, { field });
}
export function revision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    fail("VALIDATION", "修订号无效");
}
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
export const checksum = (content: SkillContent) =>
  digest(
    [...content.files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => ({
        path: f.path,
        content: f.content,
        mediaType: f.mediaType,
      })),
  );
export const emptyContent = (): SkillContent => ({ files: [] });
export function validateContent(value: SkillContent, complete = true): SkillContent {
  if (!value || !Array.isArray(value.files) || value.files.length > 256)
    fail("VALIDATION", "内容必须包含文件清单（最多256个文件）");
  const seen = new Set<string>();
  let bytes = 0;
  const files = value.files.map((file): SkillFile => {
    if (
      !file ||
      typeof file.path !== "string" ||
      !file.path ||
      file.path.length > 240 ||
      /[\\\x00-\x1f:#?%]/.test(file.path) ||
      file.path.startsWith("/") ||
      file.path.split("/").some((x) => !x || x === "." || x === "..") ||
      posix.normalize(file.path) !== file.path
    )
      fail("VALIDATION", "资源路径必须是规范的相对路径", { path: file?.path });
    if (seen.has(file.path))
      fail("VALIDATION", "资源路径重复", { path: file.path });
    seen.add(file.path);
    if (
      typeof file.content !== "string" ||
      file.content.includes("\0") ||
      !file.content.isWellFormed()
    )
      fail("VALIDATION", "仅支持有效UTF-8文本资源", { path: file.path });
    if (
      typeof file.mediaType !== "string" ||
      !/^(text\/(plain|markdown|csv|javascript|x-python|x-shellscript|yaml)|application\/(json|yaml|javascript))$/.test(
        file.mediaType,
      )
    )
      fail("VALIDATION", "不支持此资源类型", { path: file.path });
    if (complete && file.mediaType === "application/json") {
      try {
        JSON.parse(file.content);
      } catch {
        fail("VALIDATION", "JSON资源格式无效", { path: file.path });
      }
    }
    bytes += Buffer.byteLength(file.content);
    if (bytes > 2 * 1024 * 1024) fail("VALIDATION", "内容包不能超过2 MiB");
    return {
      path: file.path,
      content: file.content,
      mediaType: file.mediaType,
    };
  });
  if (!complete) return { files: files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
  const main = files.find((f) => f.path === "SKILL.md");
  if (!main || main.mediaType !== "text/markdown" || !main.content.trim())
    fail("VALIDATION", "必须提供非空的Markdown格式SKILL.md", {
      path: "SKILL.md",
    });
  for (const f of files.filter((f) => f.mediaType === "text/markdown")) {
    // Parse Markdown instead of treating code examples as resource references.
    const targets: string[] = [];
    const collect = (tokens: Token[]) => {
      for (const token of tokens) {
        if (token.type === "link_open" || token.type === "image") {
          const target = token.attrGet(token.type === "image" ? "src" : "href");
          if (target) targets.push(target);
        }
        if (token.children) collect(token.children);
      }
    };
    collect(markdown.parse(f.content, {}));
    for (const target of targets) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) continue;
      let decoded: string;
      try {
        decoded = decodeURIComponent(target.split(/[?#]/)[0]);
      } catch {
        fail("VALIDATION", "引用路径编码无效", { path: f.path, target });
      }
      const resolved = posix.normalize(
        posix.join(posix.dirname(f.path), decoded!),
      );
      if (
        decoded!.startsWith("/") ||
        decoded!.includes("\\") ||
        resolved.startsWith("../") ||
        !seen.has(resolved)
      )
        fail("RESOURCE_MISSING", "引用的资源不存在", { path: f.path, target });
    }
  }
  return {
    files: files.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
  };
}
const equal = (a?: SkillFile, b?: SkillFile) =>
  a?.content === b?.content && a?.mediaType === b?.mediaType;
export function compare(before: SkillContent, after: SkillContent): FileDiff[] {
  const a = new Map(before.files.map((f) => [f.path, f]));
  const b = new Map(after.files.map((f) => [f.path, f]));
  return [...new Set([...a.keys(), ...b.keys()])]
    .sort()
    .filter((path) => !equal(a.get(path), b.get(path)))
    .map((path) => ({
      path,
      kind: !a.has(path) ? "added" : !b.has(path) ? "removed" : "modified",
      before: a.get(path)?.content,
      after: b.get(path)?.content,
    }));
}
interface Edit {
  start: number;
  end: number;
  lines: string[];
}
function edits(base: string[], changed: string[]): Edit[] | undefined {
  const result: Edit[] = [];
  let offset = 0;
  let pending: Edit | undefined;
  // Deterministic work bound: complex changes become explicit conflicts.
  if (base.length > 20000 || changed.length > 20000) return undefined;
  const changes = diffArrays(base, changed, { maxEditLength: 2000 });
  if (!changes) return undefined;
  for (const part of changes) {
    if (part.added || part.removed) {
      pending ??= { start: offset, end: offset, lines: [] };
      if (part.removed) {
        offset += part.value.length;
        pending.end = offset;
      } else pending.lines.push(...part.value);
    } else {
      if (pending) result.push(pending);
      pending = undefined;
      offset += part.value.length;
    }
  }
  if (pending) result.push(pending);
  return result;
}
function mergeText(
  base: string,
  current: string,
  proposed: string,
): string | undefined {
  const lines = base.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const split = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const left = edits(lines, split(current));
  const right = edits(lines, split(proposed));
  if (!left || !right) return undefined;
  const all = [...left];
  for (const r of right) {
    let duplicate = false;
    for (const l of left) {
      if (JSON.stringify(l) === JSON.stringify(r)) {
        duplicate = true;
        continue;
      }
      const overlap =
        l.start === l.end || r.start === r.end
          ? l.start <= r.end && r.start <= l.end
          : l.start < r.end && r.start < l.end;
      if (overlap) return undefined;
    }
    if (!duplicate) all.push(r);
  }
  for (const e of all.sort((a, b) => b.start - a.start))
    lines.splice(e.start, e.end - e.start, ...e.lines);
  return lines.join("");
}
export function threeWay(
  base: SkillContent,
  current: SkillContent,
  proposed: SkillContent,
): { content: SkillContent; conflicts: MergeConflict[] } {
  const map = (c: SkillContent) => new Map(c.files.map((f) => [f.path, f]));
  const a = map(base),
    b = map(current),
    c = map(proposed);
  const files: SkillFile[] = [];
  const conflicts: MergeConflict[] = [];
  for (const path of [
    ...new Set([...a.keys(), ...b.keys(), ...c.keys()]),
  ].sort()) {
    const original = a.get(path),
      latest = b.get(path),
      mine = c.get(path);
    let chosen: SkillFile | undefined;
    if (equal(latest, mine)) chosen = latest;
    else if (equal(original, latest)) chosen = mine;
    else if (equal(original, mine)) chosen = latest;
    else {
      const merged =
        original &&
        latest &&
        mine &&
        original.mediaType === latest.mediaType &&
        latest.mediaType === mine.mediaType &&
        ["text/markdown", "text/plain"].includes(mine.mediaType)
          ? mergeText(original.content, latest.content, mine.content)
          : undefined;
      if (merged !== undefined) chosen = { ...mine!, content: merged };
      else {
        conflicts.push({
          path,
          base: original?.content,
          current: latest?.content,
          proposed: mine?.content,
        });
        chosen = latest;
      }
    }
    if (chosen) files.push(chosen);
  }
  return { content: { files }, conflicts };
}

/** Stable across PostgreSQL jsonb key ordering; package checksum above stays v1-compatible. */
export function canonicalDigest(value: unknown): string {
 const sort=(x:any):any=>Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;
 return digest(sort(value));
}
