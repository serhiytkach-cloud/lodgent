import { describe, expect, it } from 'vitest';
import { periodLabel, previousBillingPeriod } from '../src/billing';
import { csvCell, toCsv } from '../src/csv';
import { agentLabel, buildFunnel, daysBetween } from '../src/funnel';

describe('csv', () => {
  it('quotes separators, quotes and newlines', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          ['x,y', 'say "hi"'],
          ['line\nbreak', null],
        ],
      ),
    ).toBe('a,b\r\n"x,y","say ""hi"""\r\n"line\nbreak",\r\n');
  });

  it('neutralizes spreadsheet formulas in text but keeps numbers', () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvCell('+1 555')).toBe("'+1 555");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-12.50')).toBe('-12.50');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(' padded ')).toBe('" padded "');
  });
});

describe('billing periods', () => {
  it('bills the previous month for stays that ended before the first', () => {
    expect(previousBillingPeriod(new Date('2026-10-01T06:00:00Z'))).toEqual({
      period: '2026-09',
      departedBefore: '2026-10-01',
    });
    expect(previousBillingPeriod(new Date('2027-01-15T00:00:00Z'))).toEqual({
      period: '2026-12',
      departedBefore: '2027-01-01',
    });
    expect(periodLabel('2026-09')).toBe('September 2026');
  });
});

describe('agent funnel', () => {
  const claude = { agentClientId: null, partnerName: null, clientName: 'claude-ai', channel: 'mcp' as const };
  const partner = {
    agentClientId: 'p1',
    partnerName: 'TripPlanner',
    clientName: 'tp-bot',
    channel: 'rest' as const,
  };
  const anon = { agentClientId: null, partnerName: null, clientName: null, channel: 'rest' as const };

  it('labels agents by partner name, then client name, then channel', () => {
    expect(agentLabel(partner)).toEqual({ name: 'TripPlanner', partner: true, channel: 'rest' });
    expect(agentLabel(claude)).toEqual({ name: 'claude-ai', partner: false, channel: 'mcp' });
    expect(agentLabel(anon).name).toBe('Anonymous API client');
  });

  it('lists days in the window', () => {
    expect(daysBetween('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01']);
  });

  it('adds events and bookings into stages, agents and days with step conversion', () => {
    const f = buildFunnel({
      from: '2026-10-01',
      to: '2026-10-03',
      events: [
        { ...claude, day: '2026-10-01', kind: 'search_impression', count: 10 },
        { ...claude, day: '2026-10-01', kind: 'hotel_view', count: 4 },
        { ...claude, day: '2026-10-02', kind: 'offers_view', count: 2 },
        { ...claude, day: '2026-10-02', kind: 'hold_created', count: 2 },
        { ...partner, day: '2026-10-02', kind: 'search_impression', count: 10 },
        { ...anon, day: '2026-09-30', kind: 'search_impression', count: 3 }, // outside the daily window
      ],
      bookings: [{ ...claude, day: '2026-10-02', started: 2, paid: 1, reserved: 1 }],
    });
    expect(f.totals).toEqual({
      searches: 23,
      views: 4,
      offers: 2,
      holds: 2,
      checkouts: 2,
      paid: 1,
      reservations: 1,
    });
    expect(f.stages.map((s) => s.conversion)).toEqual([null, 17, 50, 100, 100, 50, 100]);
    expect(f.byAgent[0]).toMatchObject({ name: 'claude-ai', counts: { searches: 10, reservations: 1 } });
    expect(f.byAgent.map((a) => a.name)).toEqual(['claude-ai', 'TripPlanner', 'Anonymous API client']);
    expect(f.daily).toEqual([
      {
        date: '2026-10-01',
        searches: 10,
        views: 4,
        offers: 0,
        holds: 0,
        checkouts: 0,
        paid: 0,
        reservations: 0,
      },
      {
        date: '2026-10-02',
        searches: 10,
        views: 0,
        offers: 2,
        holds: 2,
        checkouts: 2,
        paid: 1,
        reservations: 1,
      },
    ]);
  });
});
