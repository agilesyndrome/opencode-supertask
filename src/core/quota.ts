/**
 * Provider 用量限额（usage limit）解析（纯函数）。
 *
 * OpenCode 在配额耗尽时以 `provider.quota: Usage limit reached for 5 hour.
 * Your limit will reset at 2026-11-06 10:02:18` 形式退出。此类失败不是任务
 * 自身的问题：重试应等到限额重置，且不应消耗重试预算；off-peak 任务在
 * 领取路径上仍受闲时窗口闸门约束（reset 落在峰值时段时继续等待）。
 */

const QUOTA_ERROR_RE = /provider\.quota:\s*Usage limit reached/i;
/** 结果日志中的稳定标记：用于 SQL LIKE 识别配额暂停的任务（横幅/统计）。 */
export const QUOTA_LOG_MARKER = 'provider.quota';
const WINDOW_RE = /Usage limit reached for (\d+)\s*(minute|hour|day)/i;
const RESET_AT_RE = /will reset at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;

/** 重置墙钟无时区标记：延迟超出窗口 + 1h 视为时区错读，退回窗口时长。 */
const RESET_TZ_SLACK_MS = 60 * 60 * 1000;
/** 重置生效缓冲，避免在重置瞬间立即重试再次撞限。 */
const RESET_BUFFER_MS = 2 * 60 * 1000;
/** 兜底上限（最长合法窗口 1 day + 缓冲），防止异常输入导致超长暂停。 */
const MAX_QUOTA_PAUSE_MS = 25 * 60 * 60 * 1000;

export function isQuotaUsageLimitError(log: string | null | undefined): boolean {
    return typeof log === 'string' && QUOTA_ERROR_RE.test(log);
}

/**
 * 模型额度/信用耗尽（OpenRouter 免费预算用尽等）。与 provider usage limit 不同：
 * 这类错误没有"重置时刻"，而是引导我们换下一个模型继续跑（模型阶梯）。
 */
const MODEL_CREDITS_RE = /insufficient credits?|credit balance(?: is)? too low|payment required|free-models-per-day/i;

export function isModelCreditsExhaustedError(log: string | null | undefined): boolean {
    return typeof log === 'string' && MODEL_CREDITS_RE.test(log);
}

/** 结果日志中的稳定标记：标识"模型阶梯已切换"的结果说明（不含配额语义）。 */
export const MODEL_LADDER_LOG_MARKER = 'model.ladder';

/**
 * 解析配额暂停的重试时刻（epoch ms）；非配额错误返回 null。
 *
 * 优先用 "will reset at" 时间戳；缺失、或相对延迟超出窗口长度 + 1h（疑似
 * 时区错读）时退回 "for N hour" 窗口时长。过早恢复是自愈的：会再次撞限
 * 并重新暂停，且不消耗重试次数，因此宁早勿晚。
 */
export function quotaRetryAfterMs(
    log: string | null | undefined,
    nowMs: number = Date.now(),
): number | null {
    if (!isQuotaUsageLimitError(log) || typeof log !== 'string') return null;

    const windowMs = parseWindowMs(log);
    let retryAfterMs: number | null = null;

    const resetMatch = RESET_AT_RE.exec(log);
    if (resetMatch) {
        // 无时区标记，ES 规范按本地墙钟解析（宿主机与账单窗口时区一致）。
        const resetAt = new Date(`${resetMatch[1].replace(' ', 'T')}`).getTime();
        if (Number.isFinite(resetAt)) {
            const delayMs = resetAt - nowMs;
            const withinWindow = windowMs === null || delayMs <= windowMs + RESET_TZ_SLACK_MS;
            if (withinWindow) retryAfterMs = nowMs + Math.max(delayMs, 0);
        }
    }
    if (retryAfterMs === null && windowMs !== null) {
        retryAfterMs = nowMs + windowMs;
    }
    if (retryAfterMs === null) return null;

    const pauseMs = Math.min(retryAfterMs - nowMs + RESET_BUFFER_MS, MAX_QUOTA_PAUSE_MS);
    return nowMs + pauseMs;
}

function parseWindowMs(log: string): number | null {
    const match = WINDOW_RE.exec(log);
    if (!match) return null;
    const value = Number(match[1]);
    if (!Number.isInteger(value) || value <= 0) return null;
    switch (match[2].toLowerCase()) {
        case 'minute': return value * 60_000;
        case 'hour': return value * 3_600_000;
        case 'day': return value * 86_400_000;
        default: return null;
    }
}
