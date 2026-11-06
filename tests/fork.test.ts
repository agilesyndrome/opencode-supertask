import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTestDb } from './helpers/mock-db';
import { dashboardApp } from '../src/web/index';
import { TaskService } from '../src/core/services/task.service';

const CWD = process.cwd();

async function post(body: Record<string, unknown>) {
    return dashboardApp.request('http://localhost/api/tasks', {
        method: 'POST',
        headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

const base = { name: '前置', agent: 'build', prompt: 'p', cwd: CWD };

describe('详情 Fork 与 dependsOn 创建', () => {
    let testDb: ReturnType<typeof setupTestDb>;
    const otherCwd = join(tmpdir(), 'supertask-fork-other');

    beforeEach(() => {
        testDb = setupTestDb();
        mkdirSync(otherCwd, { recursive: true });
    });

    test('允许依赖同 cwd 的可恢复任务', async () => {
        const parent = await TaskService.add(base);
        const response = await post({ ...base, name: '后续', dependsOn: parent.id });
        expect(response.status).toBe(201);
        const body = await response.json() as { task: { dependsOn: number | null } };
        expect(body.task.dependsOn).toBe(parent.id);
    });

    test('依赖不存在或跨任务 → 400', async () => {
        const owner = await TaskService.add(base);
        const other = await TaskService.add({ ...base, cwd: otherCwd });

        const missing = await post({ ...base, name: '失效', dependsOn: 999_999 });
        expect(missing.status).toBe(400);

        const crossCwd = await post({ ...base, name: '跨目录', cwd: otherCwd, dependsOn: owner.id });
        expect(crossCwd.status).toBe(400);

        const dead = await TaskService.add({ ...base, cwd: otherCwd, status: 'dead_letter', resultLog: 'boom' });
        expect(dead.status).toBe('dead_letter');
        const unrecoverable = await post({ name: '级联', agent: 'build', prompt: 'p', cwd: otherCwd, dependsOn: dead.id });
        expect(unrecoverable.status).toBe(400);

        expect((await TaskService.getById(other.id))?.id).toBeGreaterThan(0);
    });

    test('done/dead_letter 详情在客户端动作栏提供 Fork（SSR 暴露文案与脚本）', async () => {
        const parent = await TaskService.add({ ...base, name: '已完成', status: 'done' });
        const detail = await (await dashboardApp.request(`http://localhost/api/tasks/${parent.id}`)).json() as { status: string; _runs: unknown[] };
        expect(detail.status).toBe('done');
        const html = await (await dashboardApp.request('http://localhost/?lang=zh-CN')).text();
        expect(html).toContain("text('action.fork')");
        expect(html).toContain('function forkTask(id)');
        // 详情 API 供 Fork 预填的全部字段都在返回体中
        expect(detail._runs).toBeInstanceOf(Array);
    });
});
