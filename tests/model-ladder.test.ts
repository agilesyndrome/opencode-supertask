import { describe, test, expect } from 'bun:test';
import { setupTestDb } from './helpers/mock-db';
import { TaskService } from '../src/core/services/task.service';
import { TaskRunService } from '../src/core/services/task-run.service';
import { validateConfig } from '../src/gateway/config';
import { isModelCreditsExhaustedError, isQuotaUsageLimitError, MODEL_LADDER_LOG_MARKER } from '../src/core/quota';

const CWD = process.cwd();

describe('模型阶梯', () => {
    let testDb: ReturnType<typeof setupTestDb>;

    describe('配置校验', () => {
        test('接受由廉到贵的模型列表并去重', () => {
            const config = validateConfig({
                configVersion: 2,
                modelLadder: { peak: ['openrouter/z-ai/glm-free', 'openrouter/z-ai/glm-paid', 'openrouter/z-ai/glm-paid'], offPeak: [] },
            });
            expect(config.modelLadder.peak).toEqual(['openrouter/z-ai/glm-free', 'openrouter/z-ai/glm-paid']);
        });

        test('拒绝空条目与超过 8 档', () => {
            expect(() => validateConfig({ configVersion: 2, modelLadder: { peak: ['  '] } })).toThrow(/空模型条目/);
            expect(() => validateConfig({ configVersion: 2, modelLadder: { peak: Array.from({ length: 9 }, (_, i) => `m${i}`) } })).toThrow(/最多 8 档/);
        });
    });

    describe('额度耗尽分类', () => {
        test('识别 OpenRouter 免费额度耗尽，不与 usage-limit 混淆', () => {
            expect(isModelCreditsExhaustedError('Rate limit exceeded: free-models-per-day')).toBe(true);
            expect(isModelCreditsExhaustedError('402 Payment Required: insufficient credits')).toBe(true);
            expect(isModelCreditsExhaustedError('provider.quota: Usage limit reached for 5 hour.')).toBe(false);
            expect(isQuotaUsageLimitError('provider.quota: Usage limit reached for 5 hour.')).toBe(true);
        });
    });

    describe('failRun 阶梯切换', () => {
        test('额度受限任务切换到下一档：status 回 pending、不烧重试预算', async () => {
            testDb = setupTestDb();
            const task = await TaskService.add({ name: '阶梯任务', agent: 'build', prompt: 'p', cwd: CWD });
            await TaskService.start(task.id);
            const run = await TaskRunService.create({ taskId: task.id, status: 'running', model: 'openrouter/z-ai/glm-free' });

            const shifted = await TaskService.failRun(task.id, run.id, 'Rate limit exceeded: free-models-per-day', {
                ladderShift: {
                    nextModel: 'openrouter/z-ai/glm-paid',
                    note: `${MODEL_LADDER_LOG_MARKER}: openrouter/z-ai/glm-free → openrouter/z-ai/glm-paid（额度受限，切换续跑）`,
                },
            });
            expect(shifted?.status).toBe('pending');
            expect(shifted?.model).toBe('openrouter/z-ai/glm-paid');
            expect(shifted?.retryCount).toBe(0);
            expect(shifted?.retryAfter).toBe(null);
            expect(shifted?.resultLog).toContain(MODEL_LADDER_LOG_MARKER);
        });

        test('无阶梯指示时不改变既有行为：按重试预算走 failed', async () => {
            testDb = setupTestDb();
            const task = await TaskService.add({ name: '普通失败', agent: 'build', prompt: 'p', cwd: CWD });
            await TaskService.start(task.id);
            const run = await TaskRunService.create({ taskId: task.id, status: 'running' });

            const failed = await TaskService.failRun(task.id, run.id, '普通失败原因');
            expect(failed?.status).toBe('failed');
            expect(failed?.retryCount).toBe(1);
        });
    });
});
