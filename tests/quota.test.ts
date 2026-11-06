import { describe, test, expect, beforeEach } from 'bun:test';
import { setupTestDb } from './helpers/mock-db';
import { TaskService } from '../src/core/services/task.service';
import { TaskRunService } from '../src/core/services/task-run.service';
import { quotaRetryAfterMs, isQuotaUsageLimitError } from '../src/core/quota';

const HOUR_MS = 3_600_000;
const BUFFER_MS = 2 * 60_000;

function fmtLocalWallClock(date: Date): string {
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function quotaLog(resetAt?: Date, window = '5 hour'): string {
    const reset = resetAt ? ` Your limit will reset at ${fmtLocalWallClock(resetAt)}.` : '';
    return `opencode 退出码 1（agent=build，model=Agent/默认配置）\n`
        + `provider.quota: Usage limit reached for ${window}.${reset}`;
}

describe('quotaRetryAfterMs', () => {
    test('识别配额错误并按重置时刻暂停（加缓冲）', () => {
        const now = Date.now();
        const resetAt = new Date(now + 5 * HOUR_MS);
        const retryAfter = quotaRetryAfterMs(quotaLog(resetAt), now);

        expect(retryAfter).not.toBeNull();
        expect(retryAfter!).toBeGreaterThanOrEqual(now + 5 * HOUR_MS + BUFFER_MS - 1000);
        expect(retryAfter!).toBeLessThanOrEqual(now + 5 * HOUR_MS + BUFFER_MS + 1000);
    });

    test('缺少重置时间戳时按窗口时长回退', () => {
        const now = Date.now();
        const retryAfter = quotaRetryAfterMs(quotaLog(), now);

        expect(retryAfter).not.toBeNull();
        expect(retryAfter!).toBeGreaterThanOrEqual(now + 5 * HOUR_MS + BUFFER_MS - 1000);
        expect(retryAfter!).toBeLessThanOrEqual(now + 5 * HOUR_MS + BUFFER_MS + 1000);
    });

    test('时间戳延迟超出窗口 + 1h 视为时区错读，回退窗口时长', () => {
        const now = Date.now();
        const suspectReset = new Date(now + 20 * HOUR_MS); // 5h 窗口下不可能
        const retryAfter = quotaRetryAfterMs(quotaLog(suspectReset), now);

        expect(retryAfter).not.toBeNull();
        expect(retryAfter!).toBeLessThanOrEqual(now + 5 * HOUR_MS + BUFFER_MS + 1000);
    });

    test('已过期的重置时刻收敛到缓冲后立即重试', () => {
        const now = Date.now();
        const retryAfter = quotaRetryAfterMs(quotaLog(new Date(now - 10 * 60_000)), now);

        expect(retryAfter).not.toBeNull();
        expect(retryAfter!).toBeGreaterThanOrEqual(now + BUFFER_MS - 1000);
        expect(retryAfter!).toBeLessThanOrEqual(now + BUFFER_MS + 1000);
    });

    test('支持 minute/day 窗口单位', () => {
        const now = Date.now();
        expect(quotaRetryAfterMs(quotaLog(undefined, '30 minute'), now))
            .toBeLessThanOrEqual(now + 30 * 60_000 + BUFFER_MS + 1000);
        expect(quotaRetryAfterMs(quotaLog(undefined, '1 day'), now))
            .toBeGreaterThanOrEqual(now + 24 * HOUR_MS + BUFFER_MS - 1000);
    });

    test('非配额错误返回 null', () => {
        expect(isQuotaUsageLimitError('opencode 退出码 1\nError: boom')).toBe(false);
        expect(quotaRetryAfterMs('opencode 退出码 1\nError: boom')).toBeNull();
        expect(quotaRetryAfterMs(undefined)).toBeNull();
    });
});

describe('配额暂停 × TaskService', () => {
    let testDb: ReturnType<typeof setupTestDb>;

    beforeEach(() => {
        testDb = setupTestDb();
    });

    test('failRun 撞限：status=failed、retryCount 不变、retryAfter≈重置时刻', async () => {
        const task = await TaskService.add({ name: '撞限任务', agent: 'build', prompt: 'p', maxRetries: 2 });
        await TaskService.start(task.id);
        const run = await TaskRunService.create({ taskId: task.id, status: 'running' });

        const before = Date.now();
        const failed = await TaskService.failRun(task.id, run.id, quotaLog(new Date(before + 5 * HOUR_MS)));
        const after = Date.now();

        expect(failed?.status).toBe('failed');
        expect(failed?.retryCount).toBe(0);
        expect(failed?.retryAfter).toBeGreaterThanOrEqual(before + 5 * HOUR_MS + BUFFER_MS - 2000);
        expect(failed?.retryAfter).toBeLessThanOrEqual(after + 5 * HOUR_MS + BUFFER_MS);
        expect((await TaskRunService.getById(run.id))?.status).toBe('failed');
    });

    test('maxRetries=0 时撞限也不进 dead_letter，且不级联下游依赖', async () => {
        const head = await TaskService.add({ name: '链头', agent: 'build', prompt: 'p', maxRetries: 0 });
        const tail = await TaskService.add({ name: '链尾', agent: 'build', prompt: 'p', dependsOn: head.id });
        await TaskService.start(head.id);
        const run = await TaskRunService.create({ taskId: head.id, status: 'running' });

        const failed = await TaskService.failRun(head.id, run.id, quotaLog());
        expect(failed?.status).toBe('failed');
        expect(failed?.retryCount).toBe(0);
        expect((await TaskService.getById(tail.id))?.status).toBe('pending');
    });

    test('反复撞限始终不消耗重试预算', async () => {
        const task = await TaskService.add({ name: '循环撞限', agent: 'build', prompt: 'p', maxRetries: 1 });
        for (let i = 0; i < 3; i++) {
            await TaskService.start(task.id);
            const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
            const failed = await TaskService.failRun(task.id, run.id, quotaLog());
            expect(failed?.status).toBe('failed');
            expect(failed?.retryCount).toBe(0);
        }
    });

    test('撞限暂停期间（retryAfter 未到）闲时也不领取', async () => {
        const task = await TaskService.add({
            name: '暂停中', agent: 'build', prompt: 'p', runWindow: 'off-peak',
        });
        await TaskService.claimNext({ offPeakNow: true });
        const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
        await TaskService.failRun(task.id, run.id, quotaLog(new Date(Date.now() + 5 * HOUR_MS)));

        expect(await TaskService.next({ offPeakNow: true })).toBeNull();
        expect(await TaskService.claimNext({ offPeakNow: true })).toBeNull();
    });

    test('fail 与 recoverRun 同样适用配额暂停', async () => {
        const failed = await TaskService.add({ name: '预启动撞限', agent: 'build', prompt: 'p' });
        await TaskService.start(failed.id);
        const result = await TaskService.fail(failed.id, quotaLog());
        expect(result?.status).toBe('failed');
        expect(result?.retryCount).toBe(0);

        const recovered = await TaskService.add({ name: '恢复撞限', agent: 'build', prompt: 'p' });
        await TaskService.start(recovered.id);
        const run = await TaskRunService.create({ taskId: recovered.id, status: 'running' });
        const recovery = await TaskService.recoverRun(recovered.id, run.id, quotaLog());
        expect(recovery?.status).toBe('pending');
        expect(recovery?.retryCount).toBe(0);
        expect(recovery?.retryAfterMs).toBeGreaterThan(Date.now());
    });
});
