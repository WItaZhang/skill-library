import type { ErrorCode, SkillUpdateEvent } from '../../contracts/index.ts';
export const messages: Record<ErrorCode, string> = {
  FORBIDDEN: '无权访问', NOT_FOUND: '未找到资源', STALE_REVISION: '内容已更新，请重新查看',
  CONFLICT: '请求发生冲突', VALIDATION: '请求格式不正确', RESOURCE_MISSING: '资源缺失', UNAVAILABLE: '服务暂时不可用',
};
export function isCode(code: unknown): code is ErrorCode {
  return typeof code === 'string' && Object.hasOwn(messages, code);
}
export function isUpdate(value: unknown): value is SkillUpdateEvent {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return ['id', 'teamId', 'skillId', 'versionId', 'createdAt'].every(k => typeof e[k] === 'string')
    && (e.previousVersionId === null || typeof e.previousVersionId === 'string')
    && Number.isSafeInteger(e.sequence) && Number(e.sequence) > 0;
}

/** DomainError is host-owned user-facing text, unlike arbitrary exception messages. */
export function userMessage(value: unknown, code: ErrorCode): string {
  return typeof value === 'string' && value.trim()
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 1024)
    : messages[code];
}
const detailKeys = new Set([
  'path', 'paths', 'field', 'fields', 'message', 'reason', 'issues', 'code',
  'expectedRevision', 'actualRevision', 'currentRevision', 'draftRevision',
  'draftId', 'skillId', 'versionId', 'baseVersionId', 'currentVersionId', 'targetVersionId',
  'expectedBaseVersionId', 'missingPath', 'resourcePath',
]);
/** Bounded allowlist: never serialize stacks, exception causes or database internals. */
export function safeDetails(value: unknown, depth = 0): unknown {
  if (depth > 3) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.slice(0, 1024);
  if (Array.isArray(value)) return value.slice(0, 16).map(v => safeDetails(v, depth + 1));
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).slice(0, 32)) {
    if (!detailKeys.has(key)) continue;
    const child = safeDetails((value as Record<string, unknown>)[key], depth + 1);
    if (child !== undefined) result[key] = child;
  }
  return Object.keys(result).length ? result : undefined;
}
