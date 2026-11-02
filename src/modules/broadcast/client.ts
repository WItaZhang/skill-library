import { DomainError } from '../../contracts/index.ts';
import type { LibraryService, SkillUpdateSource } from '../../contracts/index.ts';
import { isCode, isUpdate, messages, userMessage, safeDetails } from './protocol.ts';

export function createHttpLibraryClient(options: { baseUrl?: string; fetch?: typeof fetch } = {}): LibraryService {
  const request = options.fetch ?? globalThis.fetch;
  const base = (options.baseUrl ?? '').replace(/\/$/, '');
  async function call(method: string, args: unknown[]) {
    let response: Response;
    try {
      response = await request(`${base}/api/library/${method}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Skill-Library': '1' }, body: JSON.stringify({ args }),
      });
    } catch { throw new DomainError('UNAVAILABLE', messages.UNAVAILABLE); }
    let body: { result?: unknown; error?: { code?: unknown; message?: unknown; details?: unknown } };
    try { body = await response.json(); } catch { throw new DomainError('UNAVAILABLE', messages.UNAVAILABLE); }
    if (!body || typeof body !== 'object') throw new DomainError('UNAVAILABLE', messages.UNAVAILABLE);
    if (!response.ok) {
      const code = isCode(body.error?.code) ? body.error.code : 'UNAVAILABLE';
      throw new DomainError(code, isCode(body.error?.code) ? userMessage(body.error?.message, code) : messages[code], safeDetails(body.error?.details));
    }
    if (!Object.hasOwn(body, 'result')) throw new DomainError('UNAVAILABLE', messages.UNAVAILABLE);
    return body.result as never;
  }
  return {
    listSkills: (_a, ...args) => call('listSkills', args), getSkill: (_a, ...args) => call('getSkill', args),
    createSkill: (_a, ...args) => call('createSkill', args), setMaintainers: (_a, ...args) => call('setMaintainers', args),
    listVersions: (_a, ...args) => call('listVersions', args), getVersion: (_a, ...args) => call('getVersion', args),
    compareVersions: (_a, ...args) => call('compareVersions', args), createDraft: (_a, ...args) => call('createDraft', args),
    getDraft: (_a, ...args) => call('getDraft', args), saveDraft: (_a, ...args) => call('saveDraft', args),
    publishDraft: (_a, ...args) => call('publishDraft', args), previewDraftUpdate: (_a, ...args) => call('previewDraftUpdate', args),
    applyDraftUpdate: (_a, ...args) => call('applyDraftUpdate', args), catalogSnapshot: (_a, ...args) => call('catalogSnapshot', args),
    listUpdateEvents: (_a, ...args) => call('listUpdateEvents', args), listAudit: (_a, ...args) => call('listAudit', args),
  };
}

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data?: string }) => void): void;
  removeEventListener(type: string, listener: (event: { data?: string }) => void): void;
  close(): void;
}
export interface SseClientOptions {
  baseUrl?: string;
  afterSequence?: number;
  /** Native EventSource is the default; injectable constructor for non-browser tests. */
  EventSource?: new (url: string, options?: { withCredentials?: boolean }) => EventSourceLike;
}
export function createSseSkillUpdateSource(options: SseClientOptions = {}): SkillUpdateSource {
  const after = options.afterSequence ?? 0;
  if (!Number.isSafeInteger(after) || after < 0) throw new DomainError('VALIDATION', messages.VALIDATION);
  return { subscribe(actor, handlers) {
    const Factory = options.EventSource ?? globalThis.EventSource;
    if (!Factory) throw new DomainError('UNAVAILABLE', messages.UNAVAILABLE);
    const source = new Factory(`${(options.baseUrl ?? '').replace(/\/$/, '')}/api/events?after=${after}`, { withCredentials: true });
    let active = true;
    const open = () => { if (active) handlers.onReconnect(); };
    const error = () => { if (active) handlers.onError?.(new DomainError('UNAVAILABLE', messages.UNAVAILABLE)); };
    const update = (message: { data?: string }) => {
      if (!active) return;
      let event: unknown;
      try { event = JSON.parse(message.data ?? ''); } catch { error(); return; }
      if (!isUpdate(event)) { error(); return; }
      if (event.teamId === actor.teamId) handlers.onUpdate(event);
    };
    const stop = () => {
      active = false;
      source.removeEventListener('open', open); source.removeEventListener('error', error); source.removeEventListener('skill.updated', update);
      source.removeEventListener('access.revoked', revoked);
      source.close();
    };
    const revoked = () => {
      if (!active) return;
      stop();
      handlers.onError?.(new DomainError('FORBIDDEN', messages.FORBIDDEN));
    };
    source.addEventListener('open', open); source.addEventListener('error', error); source.addEventListener('skill.updated', update);
    source.addEventListener('access.revoked', revoked);
    return () => {
      if (!active) return;
      stop();
    };
  } };
}
