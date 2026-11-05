import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_OFFPEAK_CONFIG, isOffPeakNow, type OffPeakConfig } from '../src/core/offpeak';

// SGT = UTC+8，全年无夏令时：SGT 墙钟 = UTC + 8h。
const sgtInstant = (isoUtc: string) => new Date(isoUtc);

describe('闲时窗口解析', () => {
    test('默认 Z.ai 窗口：工作日 14:00–18:00 SGT 为峰值，其余为闲时', () => {
        // 2026-11-04 是周三
        expect(isOffPeakNow(sgtInstant('2026-11-04T07:00:00Z'))).toBe(false); // 15:00 SGT 峰值
        expect(isOffPeakNow(sgtInstant('2026-11-04T02:00:00Z'))).toBe(true); // 10:00 SGT 闲时
    });

    test('边界分钟：14:00 起峰值，18:00 起闲时', () => {
        expect(isOffPeakNow(sgtInstant('2026-11-04T05:59:00Z'))).toBe(true); // 13:59 SGT
        expect(isOffPeakNow(sgtInstant('2026-11-04T06:00:00Z'))).toBe(false); // 14:00 SGT
        expect(isOffPeakNow(sgtInstant('2026-11-04T09:59:00Z'))).toBe(false); // 17:59 SGT
        expect(isOffPeakNow(sgtInstant('2026-11-04T10:00:00Z'))).toBe(true); // 18:00 SGT
    });

    test('周末全天为闲时', () => {
        // 2026-11-07 周六 15:00 SGT
        expect(isOffPeakNow(sgtInstant('2026-11-07T07:00:00Z'))).toBe(true);
        // 2026-11-08 周日 16:00 SGT
        expect(isOffPeakNow(sgtInstant('2026-11-08T08:00:00Z'))).toBe(true);
    });

    test('宿主机/多伦多夏令时切换不影响 SGT 判定', () => {
        // 多伦多 11 月第一个周日的 DST 切换前后，同样的当地 14:00 对应不同 UTC，
        // 但都落在 SGT 周一凌晨（闲时），判定必须一致。
        expect(isOffPeakNow(sgtInstant('2026-11-02T19:00:00Z'))).toBe(true); // 多伦多 EST 14:00 → SGT 周一 03:00
        expect(isOffPeakNow(sgtInstant('2026-07-06T18:00:00Z'))).toBe(true); // 多伦多 EDT 14:00 → SGT 周一 02:00
    });

    test('enabled=false 时恒为闲时（不限制领取）', () => {
        const config: OffPeakConfig = { ...DEFAULT_OFFPEAK_CONFIG, enabled: false };
        expect(isOffPeakNow(sgtInstant('2026-11-04T07:00:00Z'), config)).toBe(true);
    });

    test('自定义时区与窗口：多伦多夜晚为闲时（含跨午夜窗口）', () => {
        const config: OffPeakConfig = {
            enabled: true,
            timezone: 'America/Toronto',
            windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 23 * 60, endMinute: 6 * 60 }],
        };
        // 2026-11-04T02:00:00Z = 多伦多 EST（11 月已回标准时间，UTC-5）前一天 21:00 → 峰值窗口外? 21:00 不在 23:00–06:00
        expect(isOffPeakNow(sgtInstant('2026-11-04T02:00:00Z'), config)).toBe(true); // 21:00 → 非窗口 → 闲时
        // 2026-11-04T07:00:00Z = 多伦多 02:00 → 跨午夜窗口内 → 峰值 → 非闲时
        expect(isOffPeakNow(sgtInstant('2026-11-04T07:00:00Z'), config)).toBe(false);
        // 2026-11-04T11:00:00Z = 多伦多 06:00 → endMinute 开区间 → 闲时
        expect(isOffPeakNow(sgtInstant('2026-11-04T11:00:00Z'), config)).toBe(true);
    });

    test('未知时区抛出校验错误', () => {
        const config: OffPeakConfig = { ...DEFAULT_OFFPEAK_CONFIG, timezone: 'Mars/Olympus' };
        expect(() => isOffPeakNow(sgtInstant('2026-11-04T07:00:00Z'), config)).toThrow('不是有效的 IANA 时区');
    });

    test('weekday 由 Intl 决定而非 UTC 星期', () => {
        // 2026-11-06T18:00:00Z = SGT 周六 02:00（UTC 仍是周五）→ 闲时
        expect(isOffPeakNow(sgtInstant('2026-11-06T18:00:00Z'))).toBe(true);
        // 2026-11-09T15:30:00Z = SGT 周一 23:30（UTC 仍是周一）→ 闲时
        expect(isOffPeakNow(sgtInstant('2026-11-09T15:30:00Z'))).toBe(true);
    });

    test('runWindow 校验错误信息单一来源（offpeak.ts）', () => {
        for (const file of [
            'src/cli/index.ts',
            'plugin/supertask.ts',
            'src/core/services/task.service.ts',
            'src/core/services/task-template.service.ts',
            'src/gateway/config.ts',
        ]) {
            expect(readFileSync(join(process.cwd(), file), 'utf8')).not.toContain('runWindow 只能是');
        }
        expect(readFileSync(join(process.cwd(), 'src/core/offpeak.ts'), 'utf8')).toContain('runWindow 只能是');
    });
});
