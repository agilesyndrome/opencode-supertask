/**
 * 闲时窗口解析（纯函数）。
 *
 * run_window='off-peak' 的任务只在配置的闲时窗口外被领取。峰值窗口按配置时区的
 * 本地墙钟计算（默认 Z.ai 计费窗口：周一至周五 14:00–18:00 Asia/Singapore），与
 * 宿主机时区和夏令时无关；窗口结束分钟为开区间（endMinute 时刻已算闲时）。
 * 支持跨午夜窗口（endMinute <= startMinute 视为“起至午夜 + 午夜至止”两段）。
 */

export interface OffPeakWindow {
    /** 0=周日 … 6=周六（与 Intl weekday 数字约定一致） */
    days: number[];
    /** 当日起始分钟（含） */
    startMinute: number;
    /** 当日结束分钟（不含；<= startMinute 表示跨午夜） */
    endMinute: number;
}

export interface OffPeakConfig {
    enabled: boolean;
    timezone: string;
    windows: OffPeakWindow[];
}

export const DEFAULT_OFFPEAK_CONFIG: OffPeakConfig = {
    enabled: true,
    timezone: 'Asia/Singapore',
    windows: [
        { days: [1, 2, 3, 4, 5], startMinute: 14 * 60, endMinute: 18 * 60 },
    ],
};

const WEEKDAY_BY_SHORT_NAME: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
};

function zonedMinuteOfDay(instant: Date, timezone: string): { weekday: number; minuteOfDay: number } {
    let parts: Intl.DateTimeFormatPart[];
    try {
        parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(instant);
    } catch (error) {
        throw new Error(
            `scheduler.offPeak.timezone 不是有效的 IANA 时区: ${timezone}`,
            { cause: error instanceof Error ? error : undefined },
        );
    }
    const read = (type: string): string | undefined =>
        parts.find((part) => part.type === type)?.value;
    const weekday = WEEKDAY_BY_SHORT_NAME[read('weekday') ?? ''];
    const hour = Number(read('hour'));
    const minute = Number(read('minute'));
    if (weekday === undefined || !Number.isFinite(hour) || !Number.isFinite(minute)) {
        throw new Error(`scheduler.offPeak.timezone 不是有效的 IANA 时区: ${timezone}`);
    }
    return { weekday, minuteOfDay: hour * 60 + minute };
}

function coversMinute(window: OffPeakWindow, weekday: number, minuteOfDay: number): boolean {
    if (!window.days.includes(weekday)) return false;
    if (window.endMinute > window.startMinute) {
        return minuteOfDay >= window.startMinute && minuteOfDay < window.endMinute;
    }
    // 跨午夜：start 当日剩余时段 + 午夜至 end
    return minuteOfDay >= window.startMinute || minuteOfDay < window.endMinute;
}

/** true = 当前处于闲时（允许领取 run_window='off-peak' 的任务）。 */
export function isOffPeakNow(instant: Date, config: OffPeakConfig = DEFAULT_OFFPEAK_CONFIG): boolean {
    if (!config.enabled) return true;
    const { weekday, minuteOfDay } = zonedMinuteOfDay(instant, config.timezone);
    const inPeak = config.windows.some((window) => coversMinute(window, weekday, minuteOfDay));
    return !inPeak;
}

/** run_window 的合法取值（闭集；null/undefined = 不限窗口）。 */
export const RUN_WINDOWS = ['off-peak'] as const;
export type RunWindow = (typeof RUN_WINDOWS)[number];

export function validateRunWindow(value: unknown): RunWindow | null {
    if (value === undefined || value === null) return null;
    if ((RUN_WINDOWS as readonly string[]).includes(String(value))) return value as RunWindow;
    throw new Error(`runWindow 只能是 ${RUN_WINDOWS.map((w) => `'${w}'`).join(' 或 ')}`);
}

function parseWindow(value: unknown, index: number): OffPeakWindow {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`scheduler.offPeak.windows[${index}] 必须是对象`);
    }
    const record = value as Record<string, unknown>;
    const days = record.days;
    if (!Array.isArray(days) || days.length === 0 || days.length > 7
        || !days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) {
        throw new Error(`scheduler.offPeak.windows[${index}].days 必须是 0-6 的星期数组`);
    }
    const readMinute = (key: string): number => {
        const minute = record[key];
        if (!Number.isInteger(minute) || (minute as number) < 0 || (minute as number) > 1440) {
            throw new Error(`scheduler.offPeak.windows[${index}].${key} 必须是 0-1440 的整数`);
        }
        return minute as number;
    };
    const startMinute = readMinute('startMinute');
    const endMinute = readMinute('endMinute');
    if (startMinute === endMinute) {
        throw new Error(`scheduler.offPeak.windows[${index}] 起止分钟不能相同`);
    }
    const uniqueDays = [...new Set(days as number[])];
    return { days: uniqueDays, startMinute, endMinute };
}

/** 校验并规范化 scheduler.offPeak 配置；undefined 返回默认值（启用 Z.ai 峰值窗口）。 */
export function validateOffPeakConfig(value: unknown): OffPeakConfig {
    if (value === undefined) return DEFAULT_OFFPEAK_CONFIG;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('scheduler.offPeak 必须是对象');
    }
    const record = value as Record<string, unknown>;
    if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
        throw new Error('scheduler.offPeak.enabled 必须是布尔值');
    }
    if (record.timezone !== undefined && typeof record.timezone !== 'string') {
        throw new Error('scheduler.offPeak.timezone 必须是字符串');
    }
    if (record.windows !== undefined && !Array.isArray(record.windows)) {
        throw new Error('scheduler.offPeak.windows 必须是数组');
    }
    if ((record.windows?.length ?? 0) > 8) {
        throw new Error('scheduler.offPeak.windows 最多 8 个窗口');
    }
    const config: OffPeakConfig = {
        enabled: record.enabled ?? DEFAULT_OFFPEAK_CONFIG.enabled,
        timezone: record.timezone ?? DEFAULT_OFFPEAK_CONFIG.timezone,
        windows: record.windows === undefined
            ? DEFAULT_OFFPEAK_CONFIG.windows
            : (record.windows as unknown[]).map(parseWindow),
    };
    // 时区合法性：构造一次 formatter 即可验证。
    zonedMinuteOfDay(new Date(), config.timezone);
    return config;
}
