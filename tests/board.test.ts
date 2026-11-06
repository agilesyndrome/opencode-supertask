import { describe, test, expect, beforeEach } from 'bun:test';
import { setupTestDb } from './helpers/mock-db';
import { dashboardApp } from '../src/web/index';
import { TaskService, DEPENDENCY_DEAD_LOG_PREFIX } from '../src/core/services/task.service';
import { buildBoardLanes } from '../src/web/ui';

const CWD = process.cwd();

const base = { name: '看板任务', agent: 'build', prompt: 'p', cwd: CWD };

describe('buildBoardLanes 泳道分组', () => {
    let testDb: ReturnType<typeof setupTestDb>;

    beforeEach(() => {
        testDb = setupTestDb();
    });

    test('相同 cwd+batchId 的任务并入同一泳道，done 归入已完成折叠区', async () => {
        const running = await TaskService.add({ ...base, batchId: 'b-1' });
        await TaskService.start(running.id);
        await TaskService.add({ ...base, name: '排队', batchId: 'b-1' });
        await TaskService.add({ ...base, name: '已完成', status: 'done', batchId: 'b-1', resultLog: 'ok' });

        const lanes = buildBoardLanes(await TaskService.list({}));
        expect(lanes).toHaveLength(1);
        expect(lanes[0].title).toEqual({ type: 'batch', id: 'b-1' });
        expect(lanes[0].running).toHaveLength(1);
        expect(lanes[0].queued).toHaveLength(1);
        expect(lanes[0].done).toHaveLength(1);
        expect(lanes[0].done[0].name).toBe('已完成');
    });

    test('无批次任务沿 dependsOn 并入链头泳道；孤立任务单卡', async () => {
        const head = await TaskService.add(base);
        const child = await TaskService.add({ ...base, name: '子任务', dependsOn: head.id });
        await TaskService.add(base);

        const lanes = buildBoardLanes(await TaskService.list({}));
        // 链头泳道：头任务 + 依赖它的子任务；孤立任务各自单卡。
        const chainLane = lanes.find((lane) => lane.key.includes(`\u001f${head.id}`));
        expect(chainLane).toBeDefined();
        expect(chainLane!.title.type).toBe('chain');
        expect(chainLane!.queued.map((task) => task.id).sort((a, b) => a - b))
            .toEqual([head.id, child.id].sort((a, b) => a - b));
        // 头 + 子 + 孤立 = 泳道数 2（链泳道 + 单卡泳道）。
        expect(lanes).toHaveLength(2);
    });

    test('批内任务的依赖挂靠批次泳道', async () => {
        const parent = await TaskService.add({ ...base, batchId: 'b-2' });
        const child = await TaskService.add({ ...base, name: '跟随批次', dependsOn: parent.id });

        const lanes = buildBoardLanes(await TaskService.list({}));
        expect(lanes).toHaveLength(1);
        expect(lanes[0].title).toEqual({ type: 'batch', id: 'b-2' });
        expect(lanes[0].queued.map((task) => task.id)).toContain(child.id);
    });
});

describe('看板页 SSR', () => {
    let testDb: ReturnType<typeof setupTestDb>;

    beforeEach(() => {
        testDb = setupTestDb();
    });

    test('渲染泳道、看板列、WIP 与既有动作端点', async () => {
        const running = await TaskService.add({ ...base, batchId: 'b-1' });
        await TaskService.start(running.id);
        await TaskService.add({ ...base, name: '排队', batchId: 'b-1' });
        await TaskService.add({
            ...base,
            name: '阻塞',
            status: 'dead_letter',
            batchId: 'b-1',
            resultLog: `${DEPENDENCY_DEAD_LOG_PREFIX}7 已进入不可恢复终态`,
        });

        const response = await dashboardApp.request('http://localhost/board');
        expect(response.status).toBe(200);
        const html = await response.text();

        // 导航与页面骨架。
        expect(html).toContain('href="/board"');
        expect(html).toContain('看板');
        expect(html).toContain('lane-cols');
        // 批次泳道 + 三张卡片分别落在 运行中/排队中/受阻塞 列。
        expect(html).toContain('运行中');
        expect(html).toContain('受阻塞');
        expect(html).toMatch(/WIP \d+\/\d+/);
        // 卡片复用既有动作端点的客户端函数；受阻塞卡不提供 Retry。
        expect(html).toContain('onclick="pauseTask(');
        expect(html).toContain('showDetail(');
        expect(html).not.toContain('onclick="retryTask(');
        // 完成折叠区只对带批次的 done 出现（本用例无 done）；样式里的 .lane-done 选择器不算。
        expect(html).not.toContain('<details class="lane-done"');
    });

    test('批次泳道展示已完成折叠区，空看板显示空态', async () => {
        await TaskService.add({ ...base, name: '已完成', status: 'done', batchId: 'b-9', resultLog: 'ok' });
        const withDone = await dashboardApp.request('http://localhost/board');
        expect(withDone.status).toBe(200);
        const doneHtml = await withDone.text();
        expect(doneHtml).toContain('lane-done');
        expect(doneHtml).toContain('已完成');

        const empty = await dashboardApp.request('http://localhost/board?cwd=/nonexistent-project-dir');
        expect(empty.status).toBe(200);
        expect(await empty.text()).toContain('没有待处理的任务。');
    });
});
