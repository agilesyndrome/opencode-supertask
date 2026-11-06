import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * OpenCode 本机服务的最小客户端：结算时采集会话成本/用量（仅供参考，
 * 失败一律返回 null，绝不抛错、绝不阻塞结算，也绝不参与调度/重试决策）。
 */

const SERVICE_JSON_PATH = join(homedir(), '.local/state/opencode/service.json');
const SESSION_ID_RE = /^ses_[A-Za-z0-9_]+$/;

export interface OpenCodeServiceEndpoint {
    baseUrl: string;
    password: string;
}

export interface SessionCostSample {
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
}

export function resolveOpenCodeService(options: { serviceJsonPath?: string } = {}): OpenCodeServiceEndpoint | null {
    try {
        const service = JSON.parse(readFileSync(options.serviceJsonPath ?? SERVICE_JSON_PATH, 'utf-8')) as {
            url?: unknown;
            password?: unknown;
        };
        if (typeof service.url !== 'string' || !/^https?:\/\//.test(service.url)) return null;
        if (typeof service.password !== 'string' || !service.password) return null;
        return { baseUrl: service.url.replace(/\/+$/, ''), password: service.password };
    } catch {
        return null;
    }
}

function numberOf(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 读取会话最终成本与 token 用量。任何失败（服务不可达、无会话、形状不符）都返回 null。
 */
export async function fetchSessionCost(
    sessionId: string,
    options: { timeoutMs?: number; fetchImpl?: typeof fetch; service?: OpenCodeServiceEndpoint | null } = {},
): Promise<SessionCostSample | null> {
    if (!SESSION_ID_RE.test(sessionId)) return null;
    const service = options.service === undefined ? resolveOpenCodeService() : options.service;
    if (!service) return null;
    try {
        const response = await (options.fetchImpl ?? fetch)(`${service.baseUrl}/api/session/${sessionId}`, {
            headers: { Authorization: `Basic ${btoa(`opencode:${service.password}`)}` },
            signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
        });
        if (!response.ok) return null;
        const payload = (await response.json()) as Record<string, unknown>;
        const session = (payload.data ?? payload) as Record<string, unknown>;
        const cost = typeof session.cost === 'number' && Number.isFinite(session.cost) ? session.cost : null;
        if (cost === null) return null;
        const tokens = (session.tokens ?? {}) as Record<string, unknown>;
        const cache = (tokens.cache ?? {}) as Record<string, unknown>;
        return {
            costUsd: cost,
            inputTokens: numberOf(tokens.input),
            outputTokens: numberOf(tokens.output),
            reasoningTokens: numberOf(tokens.reasoning),
            cacheReadTokens: numberOf(cache.read),
        };
    } catch {
        return null;
    }
}
