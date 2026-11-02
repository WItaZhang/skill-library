import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { harness, seed, editor, openEditor, save, draftId, publishText, publish, content } from './harness.ts';
import type { Page } from '@playwright/test';

// Delay a real HTTP response after PG has committed. No response body is fabricated.
async function holdResponse(page: Page, method: string) {
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>((r) => release = r);
  const committed = new Promise<void>((r) => arrived = r);
  await page.route(`**/api/library/${method}`, async (route) => {
    const response = await route.fetch(); arrived(); await gate;
    await route.fulfill({ response });
  }, { times: 1 });
  return { committed, release };
}
async function chooseLocal(page: Page) {
  const panel = page.getByLabel('作者更新处理');
  await panel.getByRole('button', { name: '保留我的版本 · SKILL.md' }).click();
  await panel.getByLabel('我已检查最终内容，确认同步草稿基线').check();
}

test('真实双 context：v1 独立草稿 → 未保存提醒 → 过期拒绝 → 三方确认 v3 → 离线恢复 → 撤权', { timeout: 90000 }, async () => {
  const h = await harness();
  try {
    const { skill, v1 } = await seed(h);
    await openEditor(h, h.alice); await openEditor(h, h.bob);
    const aid = await draftId(h.alice.page), bid = await draftId(h.bob.page);
    assert.notEqual(aid, bid);
    const bd = await h.bob.rpc(h.team.id, 'getDraft', [bid]);
    assert.equal(bd.baseVersionId, v1.id);
    await editor(h.alice.page).fill('# v2\n甲发布'); await save(h.alice.page);
    await h.alice.page.getByLabel('修改说明').fill('甲发布第二版');
    await editor(h.bob.page).fill('# 乙未保存输入\n需要保留');
    await h.alice.page.getByRole('button', { name: '提交并生效', exact: true }).click();
    await expect(h.bob.page.getByText(/此技能已有新版本，你的修改已保留/)).toBeVisible();
    await expect(editor(h.bob.page)).toHaveValue('# 乙未保存输入\n需要保留');
    await expect(h.bob.page.getByRole('button', { name: '提交并生效', exact: true })).toBeDisabled();
    const stale = await h.bob.request('library', 'publishDraft', { args: [{ draftId: bid, expectedRevision: bd.revision, expectedBaseVersionId: v1.id, changeSummary: '过期', idempotencyKey: 'stale' }] }, h.team.id);
    assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'STALE_REVISION');
    await h.bob.page.getByRole('button', { name: '重新比较并查看更新' }).click();
    const panel = h.bob.page.getByLabel('作者更新处理');
    await expect(panel.getByRole('heading', { name: '基础内容', exact: true })).toBeVisible();
    await expect(panel.getByRole('heading', { name: '我的修改（含未保存输入）', exact: true })).toBeVisible();
    await expect(panel.getByRole('heading', { name: '团队最新版', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '保留我的版本 · SKILL.md' }).click();
    await panel.getByLabel('我已检查最终内容，确认同步草稿基线').check();
    await panel.getByRole('button', { name: '确认同步草稿', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await h.bob.page.getByLabel('修改说明').fill('乙检查后发布');
    await h.bob.page.getByRole('button', { name: '提交并生效', exact: true }).click();
    await expect(h.bob.page.getByText('v3 已自动生效')).toBeVisible();
    await h.bob.context.setOffline(true);
    await editor(h.bob.page).fill('# 离线输入仍保留');
    await publishText(h.alice, h.team.id, skill.id, '# v4 离线期间');
    await publishText(h.alice, h.team.id, skill.id, '# v5 离线期间');
    await h.bob.context.setOffline(false);
    await expect(h.bob.page.getByText(/此技能已有新版本，你的修改已保留/)).toBeVisible({ timeout: 15000 });
    await expect(editor(h.bob.page)).toHaveValue('# 离线输入仍保留');
    await h.bob.page.getByRole('button', { name: '重新比较并查看更新' }).click();
    await expect(panel).toContainText('# v5 离线期间');
    await mkdir('test-results', { recursive: true });
    await h.bob.page.screenshot({ path: 'test-results/three-way.png', fullPage: true });
    await h.alice.identity('removeMember', { teamId: h.team.id, userId: h.bob.session.user.id });
    // Must close on the SSE authority signal, without focus, writes, or the 15s fallback poll.
    await expect(editor(h.bob.page)).toHaveCount(0, { timeout: 2000 });
    assert.equal((await h.bob.request('library', 'getSkill', { args: [skill.id] }, h.team.id)).status, 403);
    assert.equal((await h.bob.request('library', 'saveDraft', { args: [{ draftId: bid, expectedRevision: bd.revision, content: bd.content }] }, h.team.id)).status, 403);
    assert.deepEqual(await h.bob.page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('skill-draft:'))), []);
  } finally { await h.close(); }
});

test('真实 HTTP/PG：同基线并发恰好一个成功；幂等重试不增版本/事件；无冲突也须确认', { timeout: 60000 }, async () => {
  const h = await harness();
  try {
    const { skill, v1 } = await seed(h);
    const drafts = await Promise.all([h.alice, h.bob].map(async (user, i) => {
      const d = await user.rpc(h.team.id, 'createDraft', [skill.id]);
      return user.rpc(h.team.id, 'saveDraft', [{ draftId: d.id, expectedRevision: d.revision,
        content: { files: [...content('# v1\n共同基础').files, { path: `references/${i}.md`, content: `独立资源 ${i}`, mediaType: 'text/markdown' }] } }]);
    }));
    const inputs = drafts.map((d, i) => ({ draftId: d.id, expectedRevision: d.revision, expectedBaseVersionId: v1.id, changeSummary: `并发 ${i}`, idempotencyKey: `concurrent-${i}` }));
    const outcomes = await Promise.all([h.alice, h.bob].map((u, i) => u.request('library', 'publishDraft', { args: [inputs[i]] }, h.team.id)));
    assert.deepEqual(outcomes.map((r) => r.status).sort(), [200, 409]);
    const winner = outcomes.findIndex((r) => r.status === 200), loser = 1 - winner;
    const users = [h.alice, h.bob];
    assert.equal((await users[winner].rpc(h.team.id, 'publishDraft', [inputs[winner]])).id, outcomes[winner].body.result.id);
    assert.equal((await h.alice.rpc(h.team.id, 'listVersions', [skill.id])).length, 2);
    assert.equal((await h.alice.rpc(h.team.id, 'listUpdateEvents', [0])).length, 2);
    const preserved = await users[loser].rpc(h.team.id, 'getDraft', [drafts[loser].id]);
    assert.deepEqual(preserved.content, drafts[loser].content);
    const preview = await users[loser].rpc(h.team.id, 'previewDraftUpdate', [{ draftId: preserved.id, expectedRevision: preserved.revision, content: preserved.content }]);
    assert.equal(preview.conflicts.length, 0);
    assert.equal((await users[loser].rpc(h.team.id, 'getDraft', [preserved.id])).baseVersionId, v1.id);
    const synced = await users[loser].rpc(h.team.id, 'applyDraftUpdate', [{ draftId: preserved.id, expectedRevision: preserved.revision, targetVersionId: preview.targetVersionId, confirmationToken: preview.confirmationToken, resolvedContent: preview.candidateContent, idempotencyKey: 'confirm-no-conflict' }]);
    assert.equal((await h.alice.rpc(h.team.id, 'listUpdateEvents', [0])).length, 2);
    assert.equal((await publish(users[loser], h.team.id, synced)).number, 3);
    assert.equal((await h.alice.rpc(h.team.id, 'listUpdateEvents', [0])).length, 3);
    const foreign = await users[winner].request('library', 'getDraft', { args: [preserved.id] }, h.team.id);
    assert.ok([403, 404].includes(foreign.status));
  } finally { await h.close(); }
});

test('真实 Chrome 延迟响应：保存/预览/同步期间继续输入，旧响应不覆盖；刷新恢复作者草稿', { timeout: 90000 }, async () => {
  const h = await harness();
  try {
    const { skill } = await seed(h); await openEditor(h, h.bob);
    const page = h.bob.page, bid = await draftId(page);
    await editor(page).fill('# 保存快照');
    const saving = await holdResponse(page, 'saveDraft');
    await page.getByRole('button', { name: '保存草稿', exact: true }).click(); await saving.committed;
    await editor(page).fill('# 保存请求后的新输入'); saving.release();
    await expect(page.locator('.save-status')).toContainText('有未保存的修改');
    await expect(editor(page)).toHaveValue('# 保存请求后的新输入');
    await save(page);
    assert.equal((await h.bob.rpc(h.team.id, 'getDraft', [bid])).content.files[0].content, '# 保存请求后的新输入');
    await publishText(h.alice, h.team.id, skill.id, '# v2 团队内容');
    await expect(page.getByText(/此技能已有新版本/)).toBeVisible();
    const previewing = await holdResponse(page, 'previewDraftUpdate');
    await page.getByRole('button', { name: '重新比较并查看更新' }).click(); await previewing.committed;
    await editor(page).fill('# 预览请求后的新输入'); previewing.release();
    const panel = page.getByLabel('作者更新处理');
    await expect(panel.getByRole('button', { name: '确认同步草稿', exact: true })).toBeDisabled();
    await expect(editor(page)).toHaveValue('# 预览请求后的新输入');
    await page.getByRole('button', { name: '重新比较并查看更新' }).click();
    await expect(panel).toContainText('# 预览请求后的新输入'); await chooseLocal(page);
    const applying = await holdResponse(page, 'applyDraftUpdate');
    await panel.getByRole('button', { name: '确认同步草稿', exact: true }).click(); await applying.committed;
    await editor(page).fill('# 同步请求期间的新输入'); applying.release();
    await expect(page.getByLabel('同步期间输入恢复')).toBeVisible();
    await expect(editor(page)).toHaveValue('# 同步请求期间的新输入');
    await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
    assert.equal((await h.bob.rpc(h.team.id, 'getDraft', [bid])).content.files[0].content, '# 预览请求后的新输入');
    await page.getByRole('button', { name: '我已对照整合，恢复保存' }).click(); await save(page);
    await openEditor(h, h.bob);
    assert.equal(await draftId(page), bid);
    await expect(editor(page)).toHaveValue('# 同步请求期间的新输入');
  } finally { await h.close(); }
});

test('真实 Chrome：预览后连续远端发布和另标签保存，保留手工选择与本地内容', { timeout: 90000 }, async () => {
  const h = await harness();
  try {
    const { skill } = await seed(h); await openEditor(h, h.bob);
    const page = h.bob.page, bid = await draftId(page);
    await editor(page).fill('# 乙自己的内容'); await save(page);
    await publishText(h.alice, h.team.id, skill.id, '# v2 甲的内容');
    await page.getByRole('button', { name: '重新比较并查看更新' }).click();
    const panel = page.getByLabel('作者更新处理');
    await panel.getByLabel('手动结果 · SKILL.md').fill('# 手工整合选择');
    await panel.getByLabel('我已检查最终内容，确认同步草稿基线').check();
    await publishText(h.alice, h.team.id, skill.id, '# v3 新的团队内容');
    await publishText(h.alice, h.team.id, skill.id, '# v4 最新团队内容');
    await expect(panel.getByRole('button', { name: '确认同步草稿', exact: true })).toBeDisabled();
    await expect(panel.getByLabel('手动结果 · SKILL.md')).toHaveValue('# 手工整合选择');
    await page.getByRole('button', { name: '重新比较并查看更新' }).click();
    await expect(panel).toContainText('# v4 最新团队内容');
    await expect(panel.getByLabel('手动结果 · SKILL.md')).toHaveValue('# 手工整合选择');
    await panel.getByLabel('已重新检查此选择 · SKILL.md').check();
    await panel.getByLabel('我已检查最终内容，确认同步草稿基线').check();
    const tab = await h.bob.context.newPage(); tab.on('dialog', (d) => void d.accept());
    await tab.goto(h.origin);
    const keys = await page.evaluate(() => Object.fromEntries(Object.keys(sessionStorage).filter((k) => k.startsWith('skill-draft:')).map((k) => [k, sessionStorage.getItem(k)!])));
    await tab.evaluate((values) => { for (const [k,v] of Object.entries(values)) sessionStorage.setItem(k,v); }, keys);
    await openEditor(h, { ...h.bob, page: tab }); assert.equal(await draftId(tab), bid);
    await editor(tab).fill('# 另一个标签保存的内容'); await save(tab);
    await panel.getByRole('button', { name: '确认同步草稿', exact: true }).click();
    await expect(page.getByText(/本地输入未被替换/)).toBeVisible();
    await expect(editor(page)).toHaveValue('# 乙自己的内容');
    await expect(panel.getByLabel('手动结果 · SKILL.md')).toHaveValue('# 手工整合选择');
    assert.equal((await h.bob.rpc(h.team.id, 'getDraft', [bid])).content.files[0].content, '# 另一个标签保存的内容');
    await page.getByRole('button', { name: '读取服务器草稿' }).click();
    await page.getByRole('button', { name: '保留我的输入，采用最新修订号' }).click();
    await expect(editor(page)).toHaveValue('# 乙自己的内容');
    const refreshed = page.waitForResponse('**/api/library/previewDraftUpdate');
    await page.getByRole('button', { name: '重新比较并查看更新' }).click();
    await refreshed;
    await expect(panel.getByLabel('已重新检查此选择 · SKILL.md')).not.toBeChecked();
    await expect(panel.getByLabel('我已检查最终内容，确认同步草稿基线')).toBeEnabled();
    await panel.getByLabel('已重新检查此选择 · SKILL.md').check();
    await panel.getByLabel('我已检查最终内容，确认同步草稿基线').check();
    await panel.getByRole('button', { name: '确认同步草稿', exact: true }).click();
    await expect(editor(page)).toHaveValue('# 手工整合选择');
  } finally { await h.close(); }
});

test('真实 Chrome：发布回包丢失后原请求重试只发布一次，后续输入与修改说明保留', { timeout: 60000 }, async () => {
  const h = await harness();
  try {
    const { skill } = await seed(h); await openEditor(h, h.bob);
    const page = h.bob.page;
    await editor(page).fill('# 待发布的第二版'); await save(page);
    await page.getByLabel('修改说明').fill('第二版说明');
    let committed!: () => void;
    const commit = new Promise<void>((r) => committed = r);
    await page.route('**/api/library/publishDraft', async (route) => {
      const response = await route.fetch(); assert.equal(response.status(), 200);
      committed(); await route.abort('failed');
    }, { times: 1 });
    await page.getByRole('button', { name: '提交并生效', exact: true }).click(); await commit;
    await expect(page.getByRole('button', { name: '重试原发布请求' })).toBeEnabled();
    await editor(page).fill('# 发布之后继续输入');
    await page.getByLabel('修改说明').fill('下一版说明应保留');
    await page.getByRole('button', { name: '重试原发布请求' }).click();
    await expect(page.getByText('v2 已自动生效')).toBeVisible();
    await expect(editor(page)).toHaveValue('# 发布之后继续输入');
    await expect(page.getByLabel('修改说明')).toHaveValue('下一版说明应保留');
    assert.equal((await h.bob.rpc(h.team.id, 'listVersions', [skill.id])).length, 2);
    assert.equal((await h.bob.rpc(h.team.id, 'listUpdateEvents', [0])).length, 2);
  } finally { await h.close(); }
});

test('真实 Chrome：降权关闭旧 SSE/工作区；离线撤权重连失效；账号与团队缓存不串用', { timeout: 90000 }, async () => {
  const h = await harness();
  try {
    const { skill } = await seed(h); await openEditor(h, h.bob);
    await editor(h.bob.page).fill('# 降权前的输入');
    await h.alice.identity('changeRole', { teamId: h.team.id, userId: h.bob.session.user.id, role: 'viewer' });
    await expect(editor(h.bob.page)).toHaveCount(0, { timeout: 2000 });
    assert.equal((await h.bob.request('library', 'createDraft', { args: [skill.id] }, h.team.id)).status, 403);
    assert.equal((await h.bob.rpc(h.team.id, 'getSkill', [skill.id])).id, skill.id, 'viewer retains authorized reads only');
    await h.alice.identity('changeRole', { teamId: h.team.id, userId: h.bob.session.user.id, role: 'contributor' });
    await openEditor(h, h.bob);
    const other = await h.bob.identity('createTeam', { name: '乙的另一个团队' });
    await h.bob.page.reload(); await h.bob.page.getByLabel('当前团队').selectOption(h.team.id);
    await h.bob.page.getByRole('button', { name: /双人编辑技能.*查看/ }).click(); await h.bob.page.getByRole('button', { name: '编辑技能', exact: true }).click();
    await editor(h.bob.page).fill('# 团队一未保存内容');
    await h.bob.page.getByText('团队与成员', { exact: true }).click();
    await h.bob.page.getByLabel('当前团队').selectOption(other.id);
    await expect(editor(h.bob.page)).toHaveCount(0);
    await expect(h.bob.page.getByRole('button', { name: /双人编辑技能.*查看/ })).toHaveCount(0);
    assert.deepEqual(await h.bob.page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('skill-draft:'))), []);
    await openEditor(h, h.bob);
    await h.bob.context.setOffline(true); await editor(h.bob.page).fill('# 离线撤权输入');
    await h.alice.identity('removeMember', { teamId: h.team.id, userId: h.bob.session.user.id });
    await h.bob.context.setOffline(false);
    await expect(editor(h.bob.page)).toHaveCount(0, { timeout: 8000 });
    // Replace this context's session through the same real callback flow.
    const first = await h.bob.context.request.get(h.origin + '/api/identity/login', { maxRedirects: 0 });
    const callback = new URL(first.headers().location); callback.searchParams.set('code', 'charlie');
    await h.bob.context.request.get(callback.href, { maxRedirects: 0 });
    await h.bob.page.reload();
    await expect(h.bob.page.getByLabel('登录账号')).toContainText('charlie');
    await expect(h.bob.page.getByRole('option', { name: /真实协作验收团队/ })).toHaveCount(0);
    assert.deepEqual(await h.bob.page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('skill-draft:'))), []);
  } finally { await h.close(); }
});
