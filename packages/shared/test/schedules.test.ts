import { describe, expect, it } from 'vitest';
import { SCHEDULES } from '../src';

const RATE = /^rate\((\d+) (minute|minutes|hour|hours|day|days)\)$/;
const UNIT_MINUTES = { minute: 1, minutes: 1, hour: 60, hours: 60, day: 1440, days: 1440 } as const;

describe('SCHEDULES', () => {
  it('has unique names that are valid EventBridge Scheduler names', () => {
    const names = SCHEDULES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9-]{1,64}$/);
  });

  it('uses rate() or six-field cron() expressions', () => {
    for (const { expression } of SCHEDULES) {
      const cron = /^cron\((.+)\)$/.exec(expression);
      if (cron) expect(cron[1]?.trim().split(/\s+/)).toHaveLength(6);
      else expect(expression).toMatch(RATE);
    }
  });

  it('keeps rate() expressions in step with the local interval', () => {
    for (const schedule of SCHEDULES) {
      const rate = RATE.exec(schedule.expression);
      if (!rate) continue;
      const unit = rate[2] as keyof typeof UNIT_MINUTES;
      expect(Number(rate[1]) * UNIT_MINUTES[unit], schedule.name).toBe(schedule.everyMinutes);
      // EventBridge requires the singular unit for a value of 1 and the plural otherwise.
      expect(rate[1] === '1', schedule.name).toBe(!unit.endsWith('s'));
    }
  });

  it('describes jobs as a type plus a JSON payload', () => {
    for (const { job } of SCHEDULES) {
      expect(job.type).toMatch(/^[a-z]+\.[a-z-]+$/);
      expect(JSON.parse(JSON.stringify(job.payload))).toEqual(job.payload);
    }
  });
});
