/**
 * 一次性补采：为历史已结算、有 sessionId 但尚无成本的执行补录 OpenCode 会话成本/用量。
 * 用法：bun scripts/backfill-run-costs.ts（连接生产库；会话不可解析的保留 null）。
 */
import { and, isNotNull, isNull, ne } from 'drizzle-orm';
import { db, schema } from '@core/db';
import { fetchSessionCost } from '@core/opencode-server';
import { TaskRunService } from '@core/services/task-run.service';

const rows = await db
    .select({ id: schema.taskRuns.id, sessionId: schema.taskRuns.sessionId })
    .from(schema.taskRuns)
    .where(and(
        ne(schema.taskRuns.status, 'running'),
        isNotNull(schema.taskRuns.sessionId),
        isNull(schema.taskRuns.costUsd),
    ));

let captured = 0;
let missed = 0;
for (const row of rows) {
    if (!row.sessionId) continue;
    const sample = await fetchSessionCost(row.sessionId);
    if (!sample) {
        missed += 1;
        continue;
    }
    await TaskRunService.recordCost(row.id, sample);
    captured += 1;
}

console.log(JSON.stringify({ scanned: rows.length, captured, missed }));
process.exit(0);
