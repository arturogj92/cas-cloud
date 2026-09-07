import assert from 'node:assert/strict';
import test from 'node:test';

import {
  consumeRelayQuota,
  dailyRequestLimit,
  DAILY_REQUEST_LIMIT,
  MONTHLY_BILLABLE_UNIT_LIMIT,
  WEBSOCKET_QUOTA_MAX_RESERVATION,
} from '../src/quota.js';

class QuotaDb {
  constructor(row) {
    this.row = row;
  }

  prepare(sql) {
    if (sql.startsWith('SELECT')) return { first: async () => this.row };
    return {
      bind: (day, month, requestCount, units, dailyUnitLimit, monthlyLimit) => ({
        first: async () => {
          const dayRequests = this.row.day === day
            ? this.row.day_requests + requestCount
            : requestCount;
          const dayUnits = this.row.day === day ? this.row.day_units + units : units;
          const monthUnits = this.row.month === month ? this.row.month_units + units : units;
          if (dayUnits > dailyUnitLimit || monthUnits > monthlyLimit) return null;
          this.row = {
            day,
            day_requests: dayRequests,
            day_units: dayUnits,
            month,
            month_units: monthUnits,
          };
          return this.row;
        },
      }),
    };
  }
}

test('cuts relay usage before the daily and paid monthly allowances', async () => {
  const dailyDb = new QuotaDb({
    day: '2026-09-02',
    day_requests: 12,
    day_units: DAILY_REQUEST_LIMIT * 20 - 1,
    month: '2026-09',
    month_units: 100,
  });
  assert.equal((await consumeRelayQuota(dailyDb, 'websocket', Date.UTC(2026, 8, 2, 23))).allowed, true);
  assert.deepEqual(
    await consumeRelayQuota(dailyDb, 'websocket', Date.UTC(2026, 8, 2, 23)),
    {
      allowed: false,
      reason: 'daily',
      retryAt: '2026-09-03T00:00:00.000Z',
      ...dailyDb.row,
    },
  );

  const monthlyDb = new QuotaDb({
    day: '2026-09-02',
    day_requests: 10,
    day_units: 200,
    month: '2026-09',
    month_units: MONTHLY_BILLABLE_UNIT_LIMIT - 19,
  });
  assert.equal((await consumeRelayQuota(monthlyDb, 'http', Date.UTC(2026, 8, 2))).reason, 'monthly');
  assert.equal(
    (await consumeRelayQuota(monthlyDb, 'websocket', Date.UTC(2026, 8, 2))).allowed,
    true,
  );
});

test('reserves websocket quota atomically without crossing the safety stop', async () => {
  const now = Date.UTC(2026, 8, 4, 12);
  const allowedDb = new QuotaDb({
    day: '2026-09-04',
    day_requests: 200,
    day_units: DAILY_REQUEST_LIMIT * 20 - WEBSOCKET_QUOTA_MAX_RESERVATION,
    month: '2026-09',
    month_units: 500,
  });
  const allowed = await consumeRelayQuota(
    allowedDb,
    'websocket',
    now,
    WEBSOCKET_QUOTA_MAX_RESERVATION,
  );
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.day_requests, 200 + WEBSOCKET_QUOTA_MAX_RESERVATION);
  assert.equal(allowed.day_units, DAILY_REQUEST_LIMIT * 20);

  const blockedDb = new QuotaDb({
    day: '2026-09-04',
    day_requests: 200,
    day_units: DAILY_REQUEST_LIMIT * 20 - WEBSOCKET_QUOTA_MAX_RESERVATION + 1,
    month: '2026-09',
    month_units: 500,
  });
  const blocked = await consumeRelayQuota(
    blockedDb,
    'websocket',
    now,
    WEBSOCKET_QUOTA_MAX_RESERVATION,
  );
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'daily');
  assert.equal(blockedDb.row.day_requests, 200);

  const monthlyDb = new QuotaDb({
    day: '2026-09-04', day_requests: 0, day_units: 0,
    month: '2026-09', month_units: MONTHLY_BILLABLE_UNIT_LIMIT - 99,
  });
  const monthly = await consumeRelayQuota(monthlyDb, 'websocket', now, 100);
  assert.equal(monthly.allowed, false);
  assert.equal(monthly.reason, 'monthly');
  assert.equal(monthlyDb.row.month_units, MONTHLY_BILLABLE_UNIT_LIMIT - 99);
  assert.equal((await consumeRelayQuota(monthlyDb, 'websocket', now, 101)).reason, 'unavailable');
  assert.equal((await consumeRelayQuota(monthlyDb, 'websocket', Date.UTC(2026, 9, 1), 100)).allowed, true);
  assert.equal(monthlyDb.row.month_units, 100);
});

test('raises the daily stop only for 2026-09-01 UTC', async () => {
  const today = Date.UTC(2026, 8, 1, 23, 59);
  assert.equal(dailyRequestLimit(today), 300_000);
  assert.equal(dailyRequestLimit(Date.UTC(2026, 8, 2)), DAILY_REQUEST_LIMIT);

  const db = new QuotaDb({
    day: '2026-09-01',
    day_requests: 12,
    day_units: 300_000 * 20 - 1,
    month: '2026-09',
    month_units: 100,
  });
  assert.equal((await consumeRelayQuota(db, 'websocket', today)).allowed, true);
  assert.equal((await consumeRelayQuota(db, 'websocket', today)).reason, 'daily');
});
