import { describe, test, expect, beforeEach } from 'bun:test';
import { setupTestDb } from './helpers/mock-db';
import { dashboardApp } from '../src/web/index';
import {
    TaskService,
    MANUAL_PAUSE_MARKER,
    PAUSED_RETRY_AFTER_SENTINEL,
} from '../src/core/services/task.service';
import { TaskRunService } from '../src/core/services/task-run.service';
import { QUOTA_LOG_MARKER } from '../src/core/quota';

const PAUSE_LOG = `${MANUAL_PAUSE_MARKER}（用户请求，Resume 恢复）`;
const QUOTA_LOG = `opencode 退出码 1（agent=build）\n${QUOTA_LOG_MARKER}: Usage limit reached for 5 hour. `
    + `Your limit will reset at 2099-01-01 00:00:00`;

describe('手动暂停 × TaskService', () => {
    let testDb: ReturnType<typeof setupTestDb>;

    beforeEach(() => {
        testDb = setupTestDb();
    });

    test('pauseRun 停靠运行中任务：failed + 哨兵 retryAfter，不耗预算、不级联依赖', async () => {
        const head = await TaskService.add({ name: '链头', agent: 'build', prompt: 'p' });
        const tail = await TaskService.add({ name: '链尾', agent: 'build', prompt: 'p', dependsOn: head.id });
        await TaskService.start(head.id);
        const run = await TaskRunService.create({ taskId: head.id, status: 'running' });

        const paused = await TaskService.pauseRun(head.id, PAUSE_LOG);

        expect(paused?.status).toBe('failed');
        expect(paused?.retryAfter).toBe(PAUSED_RETRY_AFTER_SENTINEL);
        expect(paused?.retryCount).toBe(0);
        expect((await TaskRunService.getById(run.id))?.status).toBe('failed');
        expect((await TaskService.getById(tail.id))?.status).toBe('pending');
    });

    test('pauseRun 拒绝非 running 任务', async () => {
        const task = await TaskService.add({ name: '排队中', agent: 'build', prompt: 'p' });
        expect(await TaskService.pauseRun(task.id, PAUSE_LOG)).toBeNull();
    });

    test('手动 retry（Play）清空停靠恢复 pending', async () => {
        const task = await TaskService.add({ name: '停靠', agent: 'build', prompt: 'p' });
        await TaskService.start(task.id);
        await TaskRunService.create({ taskId: task.id, status: 'running' });
        await TaskService.pauseRun(task.id, PAUSE_LOG);

        const resumed = await TaskService.retry(task.id);
        expect(resumed?.status).toBe('pending');
        expect(resumed?.retryAfter).toBeNull();
    });

    test('stats 区分配额暂停与手动暂停；listPaused 返回两类', async () => {
        const quotaTask = await TaskService.add({ name: '撞限', agent: 'build', prompt: 'p' });
        await TaskService.start(quotaTask.id);
        const run = await TaskRunService.create({ taskId: quotaTask.id, status: 'running' });
        await TaskService.failRun(quotaTask.id, run.id, QUOTA_LOG);

        const pausedTask = await TaskService.add({ name: '手停', agent: 'build', prompt: 'p' });
        await TaskService.start(pausedTask.id);
        await TaskRunService.create({ taskId: pausedTask.id, status: 'running' });
        await TaskService.pauseRun(pausedTask.id, PAUSE_LOG);

        const stats = await TaskService.stats();
        expect(stats.quotaPaused).toBe(1);
        expect(stats.quotaPausedUntil).toBeGreaterThan(Date.now());
        expect(stats.quotaPausedUntil).toBeLessThan(PAUSED_RETRY_AFTER_SENTINEL);
        expect(stats.manualPaused).toBe(1);

        const paused = await TaskService.listPaused();
        expect(paused.map((task) => task.id).sort()).toEqual([quotaTask.id, pausedTask.id].sort());
    });
});

describe('手动暂停 × Dashboard', () => {
    let testDb: ReturnType<typeof setupTestDb>;

    beforeEach(() => {
        testDb = setupTestDb();
    });

    test('pause 接口停靠运行中任务；跨站请求被拒绝；非运行中返回 409；不存在返回 404', async () => {
        const task = await TaskService.add({ name: '暂停目标', agent: 'build', prompt: 'p' });
        await TaskService.start(task.id);
        await TaskRunService.create({ taskId: task.id, status: 'running' });

        const evil = await dashboardApp.request(`/api/tasks/${task.id}/pause`, {
            method: 'POST', headers: { origin: 'https://evil.example' },
        });
        expect(evil.status).toBe(403);

        const ok = await dashboardApp.request(`/api/tasks/${task.id}/pause`, { method: 'POST' });
        expect(ok.status).toBe(200);
        const paused = await TaskService.getById(task.id);
        expect(paused?.status).toBe('failed');
        expect(paused?.retryAfter).toBe(PAUSED_RETRY_AFTER_SENTINEL);

        const finished = await dashboardApp.request(`/api/tasks/${task.id}/pause`, { method: 'POST' });
        expect(finished.status).toBe(409);

        const missing = await dashboardApp.request('/api/tasks/999999/pause', { method: 'POST' });
        expect(missing.status).toBe(404);
    });

    test('横幅：停靠任务渲染 Resume，运行中任务渲染 Pause，空队列无横幅', async () => {
        const pausedTask = await TaskService.add({ name: '停靠横幅', agent: 'build', prompt: 'p' });
        await TaskService.start(pausedTask.id);
        await TaskRunService.create({ taskId: pausedTask.id, status: 'running' });
        await TaskService.pauseRun(pausedTask.id, PAUSE_LOG);

        const runningTask = await TaskService.add({ name: '运行横幅', agent: 'build', prompt: 'p' });
        await TaskService.start(runningTask.id);
        await TaskRunService.create({ taskId: runningTask.id, status: 'running' });

        const page = await (await dashboardApp.request('/', { headers: { 'accept-language': 'en' } })).text();
        expect(page).toContain('aria-label="Queue status"');
        expect((page.match(/Resume</g) ?? []).length).toBeGreaterThanOrEqual(1);
        expect(page).toContain('Pause');
        expect(page).toContain('paused manually');
        expect(page).toContain('停靠横幅');

        await TaskService.cancel(runningTask.id);
        await TaskService.retry(pausedTask.id);
        const quiet = await (await dashboardApp.request('/', { headers: { 'accept-language': 'en' } })).text();
        expect(quiet).not.toContain('aria-label="Queue status"');
        expect(quiet).not.toContain('onclick="pauseTask(');
        expect(quiet).not.toContain('▶');
    });
});
