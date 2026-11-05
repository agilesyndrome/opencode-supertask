import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync, spawn } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('数据库迁移入口', () => {
    test('db:migrate 可从源码目录执行并创建最新约束与索引', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-migration-'));
        dirs.push(dir);
        const dbPath = join(dir, 'tasks.db');

        const output = execFileSync('bun', ['run', 'db:migrate'], {
            cwd: process.cwd(),
            env: { ...process.env, SUPERTASK_DB_PATH: dbPath },
            encoding: 'utf8',
        });
        expect(output).toContain('Database migration completed');

        const sqlite = new Database(dbPath);
        const taskColumns = sqlite.query('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
        const templateColumns = sqlite.query('PRAGMA table_info(task_templates)').all() as Array<{ name: string }>;
        const runColumns = sqlite.query('PRAGMA table_info(task_runs)').all() as Array<{ name: string }>;
        const taskIndexes = sqlite.query('PRAGMA index_list(tasks)').all() as Array<{ name: string }>;
        const runForeignKeys = sqlite.query('PRAGMA foreign_key_list(task_runs)').all() as Array<{ on_delete: string }>;

        expect(taskColumns.some((column) => column.name === 'retry_backoff_ms')).toBe(true);
        expect(taskColumns.some((column) => column.name === 'variant')).toBe(true);
        expect(taskColumns.some((column) => column.name === 'run_window')).toBe(true);
        expect(templateColumns.some((column) => column.name === 'batch_id')).toBe(true);
        expect(templateColumns.some((column) => column.name === 'timeout_ms')).toBe(true);
        expect(templateColumns.some((column) => column.name === 'variant')).toBe(true);
        expect(runColumns.some((column) => column.name === 'variant')).toBe(true);
        expect(taskIndexes.some((item) => item.name === 'tasks_queue_idx')).toBe(true);
        expect(runForeignKeys.some((item) => item.on_delete.toLowerCase() === 'cascade')).toBe(true);
        sqlite.close();
    });

    test('run_window 迁移为加列：既有任务行保留且 run_window 为 null', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-run-window-migration-'));
        dirs.push(dir);

        // 迁移到 0008（截断 journal，模拟升级前的旧库）
        const oldFolder = join(dir, 'drizzle-old');
        cpSync(join(process.cwd(), 'drizzle'), oldFolder, { recursive: true });
        const journalPath = join(oldFolder, 'meta', '_journal.json');
        const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ idx: number }> };
        journal.entries = journal.entries.filter((entry) => entry.idx < 9);
        writeFileSync(journalPath, JSON.stringify(journal));

        const dbPath = join(dir, 'tasks.db');
        const legacy = new Database(dbPath);
        migrate(drizzle(legacy), { migrationsFolder: oldFolder });
        legacy.exec(
            `INSERT INTO tasks (name, agent, prompt, created_at) VALUES ('legacy-row', 'build', 'p', ${Math.floor(Date.now() / 1000)})`,
        );
        const legacyId = (legacy.query('SELECT id FROM tasks ORDER BY id DESC').get() as { id: number }).id;
        legacy.close();

        // 真实迁移目录（含 0009）补齐 run_window
        const upgraded = new Database(dbPath);
        migrate(drizzle(upgraded), { migrationsFolder: join(process.cwd(), 'drizzle') });
        const columns = upgraded.query('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
        expect(columns.some((column) => column.name === 'run_window')).toBe(true);
        const row = upgraded.query('SELECT id, name, run_window FROM tasks WHERE id = ?').get(legacyId) as {
            id: number;
            name: string;
            run_window: string | null;
        };
        expect(row.id).toBe(legacyId);
        expect(row.name).toBe('legacy-row');
        expect(row.run_window).toBeNull();
        upgraded.close();
    });
});

describe('并发首次打开数据库', () => {
    test('多个进程同时创建并迁移同一新库时全部成功', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-concurrent-open-'));
        try {
            const script = join(dir, 'open.ts');
            writeFileSync(script, `const { getDb, closeDb } = await import(${JSON.stringify(join(process.cwd(), 'src/core/db/index.ts'))});\ngetDb();\ncloseDb();\n`);
            for (let round = 0; round < 3; round += 1) {
                const databasePath = join(dir, `round-${round}.db`);
                const exits = await Promise.all(Array.from({ length: 5 }, () => new Promise<number | null>((resolve) => {
                    const child = spawn(process.execPath, [script], {
                        env: { ...process.env, SUPERTASK_DB_PATH: databasePath },
                        stdio: 'ignore',
                    });
                    child.once('close', resolve);
                })));
                expect(exits).toEqual([0, 0, 0, 0, 0]);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);
});

