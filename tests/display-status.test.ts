import { describe, test, expect, beforeEach } from 'bun:test';
import { eq } from 'drizzle-orm';
import * as schema from '../src/core/db/schema';
import type { Task } from '../src/core/db/schema';
import { setupTestDb } from './helpers/mock-db';
import { dashboardApp } from '../src/web/index';
import { TaskService, PAUSED_RETRY_AFTER_SENTINEL, DEPENDENCY_DEAD_LOG_PREFIX } from '../src/core/services/task.service';
import { resolveDisplayStatus } from '../src/web/ui';
import { QUOTA_LOG_MARKER } from '../src/core/quota';

const NOW = 1_700_000_000_000;
const ROOT_DIR = process.cwd();

function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: 7,
        name: 'task',
        agent: 'build',
        prompt: 'p',
        status: 'pending',
        resultLog: null,
        retryAfter: null,
        ...overrides,
    } as Task;
}

describe('resolveDisplayStatus', () => {
    test('dead_letter + 依赖级联标记 → blocked（提示被 #N 阻塞）', () => {
        const result = resolveDisplayStatus('zh-CN', makeTask({
            status: 'dead_letter',
            resultLog: '依赖任务 #3 已进入不可恢复终态',
        }), NOW);
        expect(result.kind).toBe('blocked');
        expect(result.label).toBe('受阻塞');
        expect(result.subtitle).toContain('#3');
    });

    test('dead_letter 无级联标记 → stopped（保留死信语义）', () => {
        const result = resolveDisplayStatus('zh-CN', makeTask({ status: 'dead_letter' }), NOW);
        // 已停止=真实失败，红色徽章；受阻塞保持黄色（b-dead_letter）。
        expect(result.kind).toBe('stopped');
        expect(result.badgeClass).toBe('b-failed');
    });

    test('failed + 哨兵 retryAfter → paused · manual', () => {
        const result = resolveDisplayStatus('zh-CN', makeTask({
            status: 'failed',
            retryAfter: PAUSED_RETRY_AFTER_SENTINEL,
        }), NOW);
        expect(result.kind).toBe('paused');
        expect(result.label).toBe('已暂停 · 手动');
    });

    test('failed + 配额标记 + 未来 retryAfter → paused · quota（含恢复时间）', () => {
        const result = resolveDisplayStatus('zh-CN', makeTask({
            status: 'failed',
            retryAfter: NOW + 3_600_000,
            resultLog: `退出码 1\n${QUOTA_LOG_MARKER}: Usage limit reached`,
        }), NOW);
        expect(result.kind).toBe('paused');
        expect(result.label).toBe('已暂停 · 配额');
        expect(result.subtitle).not.toBe('');
    });

    test('failed + 未来 retryAfter（无配额标记）→ retrying（含倒计时）', () => {
        const result = resolveDisplayStatus('zh-CN', makeTask({
            status: 'failed',
            retryAfter: NOW + 120_000,
        }), NOW);
        expect(result.kind).toBe('retrying');
        expect(result.subtitle).toContain('后重试');
    });

    test('failed + 过期 retryAfter → retrying（无倒计时）', () => {
        const result = resolveDisplayStatus('zh-CN', makeTask({
            status: 'failed',
            retryAfter: NOW - 1_000,
        }), NOW);
        expect(result.kind).toBe('retrying');
        expect(result.subtitle).toBe('');
    });

    test('running/done 等透传原状态', () => {
        const running = resolveDisplayStatus('zh-CN', makeTask({ status: 'running' }), NOW);
        expect(running.kind).toBe('running');
        expect(running.badgeClass).toBe('b-running');
        const done = resolveDisplayStatus('en', makeTask({ status: 'done' }), NOW);
        expect(done.badgeClass).toBe('b-done');
    });

    test('英文文案', () => {
        const blocked = resolveDisplayStatus('en', makeTask({
            status: 'dead_letter',
            resultLog: '依赖任务 #9 已进入不可恢复终态',
        }), NOW);
        expect(blocked.label).toBe('Blocked');
        const manual = resolveDisplayStatus('en', makeTask({
            status: 'failed',
            retryAfter: PAUSED_RETRY_AFTER_SENTINEL,
        }), NOW);
        expect(manual.label).toBe('Paused · manual');
        const retrying = resolveDisplayStatus('en', makeTask({
            status: 'failed',
            retryAfter: NOW + 60_000,
        }), NOW);
        expect(retrying.label).toBe('Retrying');
    });
});

describe('队列页 SSR：按原因渲染状态与单按钮', () => {
    let testDb: ReturnType<typeof setupTestDb>;

    beforeEach(() => {
        testDb = setupTestDb();
    });

    async function addWith(patch: Partial<schema.tasks.$inferInsert>): Promise<Task> {
        const task = await TaskService.add({ name: patch.name ?? '任务', agent: 'build', prompt: 'p', cwd: ROOT_DIR, status: patch.status });
        const { name: _name, status: _status, ...rest } = patch;
        const extra = rest as schema.tasks.$inferInsert;
        if (Object.keys(extra).length > 0) {
            testDb.db.update(schema.tasks).set(extra).where(eq(schema.tasks.id, task.id)).run();
        }
        return (await TaskService.getById(task.id))!;
    }

    test('受阻塞行不提供重试按钮', async () => {
        const task = await addWith({ status: 'dead_letter', resultLog: '依赖任务 #2 已进入不可恢复终态' });
        const html = await (await dashboardApp.request('/?lang=zh-CN')).text();
        expect(html).toContain('受阻塞');
        expect(html).toContain('依赖 #2 不可恢复');
        expect(html).not.toContain(`onclick="retryTask(${task.id})"`);
    });

    test('真实死信 → 行内 Retry', async () => {
        const task = await addWith({ status: 'dead_letter', resultLog: 'boom' });
        const html = await (await dashboardApp.request('/?lang=zh-CN')).text();
        expect(html).toContain(`onclick="retryTask(${task.id})"`);
    });

    test('配额暂停 → 行内 Resume（retryTask）且展示配额标签', async () => {
        const task = await addWith({ status: 'failed', retryAfter: Date.now() + 600_000, resultLog: `${QUOTA_LOG_MARKER}: Usage limit reached` });
        const html = await (await dashboardApp.request('/?lang=zh-CN')).text();
        expect(html).toContain('已暂停 · 配额');
        expect(html).toContain(`onclick="retryTask(${task.id})"`);
        expect(html).toContain('▶ 继续');
    });

    test('退避中的 failed → Retrying 标签', async () => {
        await addWith({ status: 'failed', retryAfter: Date.now() + 90_000 });
        const html = await (await dashboardApp.request('/?lang=zh-CN')).text();
        expect(html).toContain('重试等待中');
    });

    test('行内不再出现 Continue session 与 Cancel', async () => {
        const task = await addWith({});
        const html = await (await dashboardApp.request('/?lang=zh-CN')).text();
        expect(html).not.toContain(`onclick="copySessionCommand(${task.id})"`);
        // 行内 Cancel 移除，仅保留在 Details danger zone（客户端 JS）；主表行模板不再输出 cancelTask
        const rowsArea = (html.split('<tbody>')[1] ?? '').split('</tbody>')[0];
        expect(rowsArea).not.toContain('cancelTask(');
    });

    test('未筛选视图把 done 收进 Completed 折叠区', async () => {
        await TaskService.add({ name: '已完成', agent: 'build', prompt: 'p', cwd: ROOT_DIR, status: 'done' });
        await TaskService.add({ name: '排队中', agent: 'build', prompt: 'p', cwd: ROOT_DIR });
        const html = await (await dashboardApp.request('/?lang=zh-CN')).text();
        const completedIdx = html.indexOf('class="panel-completed"');
        expect(completedIdx).toBeGreaterThan(-1);
        expect(html).toContain('已完成任务（');
        const queuedIdx = html.indexOf('排队中');
        expect(queuedIdx).toBeGreaterThan(-1);
        expect(queuedIdx).toBeLessThan(completedIdx);
        expect(html.lastIndexOf('已完成')).toBeGreaterThan(completedIdx);
    });

    test('Done 筛选视图仍平铺完整列表', async () => {
        await TaskService.add({ name: '已完成一', agent: 'build', prompt: 'p', cwd: ROOT_DIR, status: 'done' });
        const html = await (await dashboardApp.request('/?lang=zh-CN&status=done')).text();
        expect(html).not.toContain('class="panel-completed"');
        expect(html).toContain('已完成一');
    });

    test('阻塞源已恢复（done）时，默认视图的死信行展示“已恢复”并提供 Retry', async () => {
        const testDb = setupTestDb();
        const blocker = await TaskService.add({ name: '恢复了的阻塞源', agent: 'build', prompt: 'p' });
        await TaskService.done(blocker.id, 'ok');
        const blocked = await TaskService.add({ name: '曾被阻塞', agent: 'build', prompt: 'p' });
        await testDb.db.update(testDb.schema.tasks)
            .set({ status: 'dead_letter', resultLog: `${DEPENDENCY_DEAD_LOG_PREFIX}${blocker.id} 已进入不可恢复终态` })
            .where(eq(testDb.schema.tasks.id, blocked.id));

        const html = await (await dashboardApp.request('/')).text();
        expect(html).toContain(`依赖 #${blocker.id} 已恢复，可重试`);
        expect(html).toContain(`onclick="retryTask(${blocked.id})"`);
    });
});
