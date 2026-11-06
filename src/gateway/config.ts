import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { DEFAULT_OFFPEAK_CONFIG, validateOffPeakConfig, type OffPeakConfig } from '@core/offpeak';

export interface GatewayConfig {
    configVersion: 2;
    worker: {
        maxConcurrency: number;
        pollIntervalMs: number;
        heartbeatIntervalMs: number;
        taskTimeoutMs: number;
        shutdownGracePeriodMs: number;
    };
    scheduler: {
        enabled: boolean;
        checkIntervalMs: number;
        offPeak: OffPeakConfig;
    };
    watchdog: {
        heartbeatTimeoutMs: number;
        checkIntervalMs: number;
        cleanupIntervalMs: number;
        retentionDays: number;
    };
    dashboard: {
        enabled: boolean;
        port: number;
        /** 允许出现在 Host 里的额外主机名（反代场景）；小写、不带端口。 */
        extraHosts: string[];
    };
    /** OpenCode Web UI 深链（看板/队列“在 OpenCode 中打开”）；缺省时回退到本机 service.json 发现。 */
    openCodeUi?: {
        baseUrl: string;
        /** 覆盖路由里的 server key 字符串；缺省用 baseUrl 的 origin。 */
        serverKey?: string;
    };
    /**
     * 模型成本阶梯（由廉到贵）：仅作用于未显式选择模型的任务。运行因模型额度/
     * 信用耗尽失败时，按当前时段的列表切到下一档继续（不消耗重试预算）；耗尽
     * 最后一档则回退到既有的配额暂停行为。空列表 = 不启用。
     */
    modelLadder: {
        peak: string[];
        offPeak: string[];
    };
}

const DEFAULT_CONFIG: GatewayConfig = {
    configVersion: 2,
    worker: {
        maxConcurrency: 2,
        pollIntervalMs: 1000,
        heartbeatIntervalMs: 30_000,
        taskTimeoutMs: 1_800_000,
        shutdownGracePeriodMs: 30_000,
    },
    scheduler: {
        enabled: true,
        checkIntervalMs: 1000,
        offPeak: DEFAULT_OFFPEAK_CONFIG,
    },
    watchdog: {
        heartbeatTimeoutMs: 600_000,
        checkIntervalMs: 60_000,
        cleanupIntervalMs: 86_400_000,
        retentionDays: 30,
    },
    dashboard: {
        enabled: true,
        port: 4680,
        extraHosts: [],
    },
    modelLadder: {
        peak: [],
        offPeak: [],
    },
};

const DEFAULT_CONFIG_PATH = join(homedir(), '.config/opencode/supertask.json');

export function getConfigPath(): string {
    return process.env.SUPERTASK_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
    if (value === undefined) return {};
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${path} 必须是对象`);
    }
    return value as Record<string, unknown>;
}

function integerAt(
    source: Record<string, unknown>,
    key: string,
    fallback: number,
    min: number,
    max: number,
    path: string,
): number {
    const value = source[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${path}.${key} 必须是 ${min} 到 ${max} 之间的整数`);
    }
    return value;
}

/** dashboard.extraHosts：可选字符串数组；小写、去尾点、去端口后仍须是合法主机名。 */
function dashboardExtraHostsAt(source: Record<string, unknown>, key: string): string[] {
    const value = source[key];
    if (value === undefined) return DEFAULT_CONFIG.dashboard.extraHosts;
    if (!Array.isArray(value)) throw new Error(`dashboard.${key} 必须是字符串数组`);
    if (value.length > 16) throw new Error(`dashboard.${key} 最多 16 个条目`);
    const hosts: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') throw new Error(`dashboard.${key} 必须是字符串数组`);
        const host = item.trim().toLowerCase().replace(/\.+$/, '').replace(/:\d+$/, '');
        if (!/^[a-z0-9](?:[a-z0-9._-]{0,251}[a-z0-9])?$/.test(host)) {
            throw new Error(`dashboard.${key} 含无效主机名: ${item}`);
        }
        if (!hosts.includes(host)) hosts.push(host);
    }
    return hosts;
}

function booleanAt(
    source: Record<string, unknown>,
    key: string,
    fallback: boolean,
    path: string,
): boolean {    const value = source[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw new Error(`${path}.${key} 必须是布尔值`);
    return value;
}

/** 配置取值范围（毫秒或原始单位）；validateConfig 与 Dashboard 表单共用，避免两边约束漂移。 */
export const CONFIG_BOUNDS = {
    maxConcurrency: [1, 64],
    pollIntervalMs: [50, 60_000],
    heartbeatIntervalMs: [1000, 3_600_000],
    taskTimeoutMs: [1000, 604_800_000],
    shutdownGracePeriodMs: [0, 3_600_000],
    schedulerCheckIntervalMs: [100, 60_000],
    heartbeatTimeoutMs: [1000, 86_400_000],
    watchdogCheckIntervalMs: [1000, 3_600_000],
    cleanupIntervalMs: [60_000, 604_800_000],
    retentionDays: [1, 3650],
} as const satisfies Record<string, readonly [number, number]>;

export function validateConfig(input: unknown): GatewayConfig {
    const root = objectAt(input, 'config');
    const version = root.configVersion ?? 1;
    if (version !== 1 && version !== 2) {
        throw new Error('config.configVersion 只支持 1 或 2');
    }

    const worker = objectAt(root.worker, 'worker');
    const scheduler = objectAt(root.scheduler, 'scheduler');
    const watchdog = objectAt(root.watchdog, 'watchdog');
    const dashboard = objectAt(root.dashboard, 'dashboard');

    const heartbeatIntervalMs = integerAt(worker, 'heartbeatIntervalMs', DEFAULT_CONFIG.worker.heartbeatIntervalMs, ...CONFIG_BOUNDS.heartbeatIntervalMs, 'worker');
    const heartbeatTimeoutMs = integerAt(watchdog, 'heartbeatTimeoutMs', DEFAULT_CONFIG.watchdog.heartbeatTimeoutMs, ...CONFIG_BOUNDS.heartbeatTimeoutMs, 'watchdog');

    let checkIntervalMs: number;
    let cleanupIntervalMs: number;
    if (version === 1 && watchdog.checkIntervalMs === undefined && watchdog.cleanupIntervalMs !== undefined) {
        checkIntervalMs = integerAt(watchdog, 'cleanupIntervalMs', DEFAULT_CONFIG.watchdog.checkIntervalMs, ...CONFIG_BOUNDS.watchdogCheckIntervalMs, 'watchdog');
        cleanupIntervalMs = DEFAULT_CONFIG.watchdog.cleanupIntervalMs;
    } else {
        checkIntervalMs = integerAt(watchdog, 'checkIntervalMs', DEFAULT_CONFIG.watchdog.checkIntervalMs, ...CONFIG_BOUNDS.watchdogCheckIntervalMs, 'watchdog');
        cleanupIntervalMs = integerAt(watchdog, 'cleanupIntervalMs', DEFAULT_CONFIG.watchdog.cleanupIntervalMs, ...CONFIG_BOUNDS.cleanupIntervalMs, 'watchdog');
    }

    if (heartbeatIntervalMs >= heartbeatTimeoutMs) {
        throw new Error('worker.heartbeatIntervalMs 必须小于 watchdog.heartbeatTimeoutMs');
    }
    if (checkIntervalMs > heartbeatTimeoutMs) {
        throw new Error('watchdog.checkIntervalMs 不能大于 watchdog.heartbeatTimeoutMs');
    }

    return {
        configVersion: 2,
        worker: {
            maxConcurrency: integerAt(worker, 'maxConcurrency', DEFAULT_CONFIG.worker.maxConcurrency, ...CONFIG_BOUNDS.maxConcurrency, 'worker'),
            pollIntervalMs: integerAt(worker, 'pollIntervalMs', DEFAULT_CONFIG.worker.pollIntervalMs, ...CONFIG_BOUNDS.pollIntervalMs, 'worker'),
            heartbeatIntervalMs,
            taskTimeoutMs: integerAt(worker, 'taskTimeoutMs', DEFAULT_CONFIG.worker.taskTimeoutMs, ...CONFIG_BOUNDS.taskTimeoutMs, 'worker'),
            shutdownGracePeriodMs: integerAt(worker, 'shutdownGracePeriodMs', DEFAULT_CONFIG.worker.shutdownGracePeriodMs, ...CONFIG_BOUNDS.shutdownGracePeriodMs, 'worker'),
        },
        scheduler: {
            enabled: booleanAt(scheduler, 'enabled', DEFAULT_CONFIG.scheduler.enabled, 'scheduler'),
            checkIntervalMs: integerAt(scheduler, 'checkIntervalMs', DEFAULT_CONFIG.scheduler.checkIntervalMs, ...CONFIG_BOUNDS.schedulerCheckIntervalMs, 'scheduler'),
            offPeak: validateOffPeakConfig(scheduler.offPeak),
        },
        watchdog: {
            heartbeatTimeoutMs,
            checkIntervalMs,
            cleanupIntervalMs,
            retentionDays: integerAt(watchdog, 'retentionDays', DEFAULT_CONFIG.watchdog.retentionDays, ...CONFIG_BOUNDS.retentionDays, 'watchdog'),
        },
        dashboard: {
            enabled: booleanAt(dashboard, 'enabled', DEFAULT_CONFIG.dashboard.enabled, 'dashboard'),
            port: integerAt(dashboard, 'port', DEFAULT_CONFIG.dashboard.port, 1, 65_535, 'dashboard'),
            extraHosts: dashboardExtraHostsAt(dashboard, 'extraHosts'),
        },
        openCodeUi: openCodeUiAt(objectAt(root.openCodeUi, 'openCodeUi'), 'openCodeUi'),
        modelLadder: modelLadderAt(objectAt(root.modelLadder, 'modelLadder'), 'modelLadder'),
    };
}

/** modelLadder：可选模型列表（peak/offPeak），由廉到贵；条目去空白去重，最多 8 档。 */
function modelLadderAt(source: Record<string, unknown>, path: string): { peak: string[]; offPeak: string[] } {
    const list = (key: string): string[] => {
        const value = source[key];
        if (value === undefined) return [];
        if (!Array.isArray(value)) throw new Error(`${path}.${key} 必须是字符串数组`);
        if (value.length > 8) throw new Error(`${path}.${key} 最多 8 档`);
        const models: string[] = [];
        for (const item of value) {
            if (typeof item !== 'string' || !item.trim()) throw new Error(`${path}.${key} 含空模型条目`);
            const model = item.trim();
            if (!/^[A-Za-z0-9~.^_:/-]+$/.test(model) || !model.includes('/')) {
                throw new Error(`${path}.${key} 条目需为 provider/model 形式且不含空格或特殊字符: ${model}`);
            }
            if (!models.includes(model)) models.push(model);
        }
        return models;
    };
    return { peak: list('peak'), offPeak: list('offPeak') };
}

/** openCodeUi：可选；未配置时运行时回退到本机 opencode 服务发现（service.json）。baseUrl 去尾斜杠。 */
function openCodeUiAt(source: Record<string, unknown>, path: string): { baseUrl: string; serverKey?: string } | undefined {
    if (Object.keys(source).length === 0) return undefined;
    const rawBase = source.baseUrl;
    if (typeof rawBase !== 'string' || !/^https?:\/\//.test(rawBase.trim())) {
        throw new Error(`${path}.baseUrl 必须是 http(s):// URL`);
    }
    const baseUrl = rawBase.trim().replace(/\/+$/, '');
    const rawKey = source.serverKey;
    if (rawKey !== undefined && (typeof rawKey !== 'string' || !rawKey.trim())) {
        throw new Error(`${path}.serverKey 必须是非空字符串`);
    }
    return { baseUrl, ...(rawKey === undefined ? {} : { serverKey: rawKey.trim() }) };
}

export function loadConfig(path = getConfigPath()): GatewayConfig {
    if (!existsSync(path)) return validateConfig({ configVersion: 2 });

    try {
        return validateConfig(JSON.parse(readFileSync(path, 'utf-8')) as unknown);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`无法读取配置 ${path}: ${message}`);
    }
}

export { DEFAULT_CONFIG, DEFAULT_CONFIG_PATH };
