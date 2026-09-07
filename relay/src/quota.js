export const DAILY_REQUEST_LIMIT = 90_000;
export const MONTHLY_BILLABLE_UNIT_LIMIT = 18_000_000;
export const DURABLE_OBJECTS_BACKOFF_MS = 60_000;
// ponytail: Reservations top out at 100 messages; lower this if abandoned sockets consume the guard reserve.
export const WEBSOCKET_QUOTA_MAX_RESERVATION = 100;

const TEMPORARY_DAILY_REQUEST_LIMIT = 300_000;
const TEMPORARY_DAILY_REQUEST_LIMIT_DAY = '2026-09-01';
const HTTP_BILLABLE_UNITS = 20;
const WEBSOCKET_BILLABLE_UNITS = 1;
const CIRCUIT_PROBE_LEASE_MS = 15_000;

const CONSUME_SQL = `
  INSERT INTO relay_quota (singleton, day, day_requests, day_units, month, month_units)
  VALUES (1, ?1, ?3, ?4, ?2, ?4)
  ON CONFLICT(singleton) DO UPDATE SET
    day = excluded.day,
    day_requests = CASE
      WHEN relay_quota.day = excluded.day THEN relay_quota.day_requests + excluded.day_requests
      ELSE excluded.day_requests
    END,
    day_units = CASE
      WHEN relay_quota.day = excluded.day THEN relay_quota.day_units + excluded.day_units
      ELSE excluded.day_units
    END,
    month = excluded.month,
    month_units = CASE
      WHEN relay_quota.month = excluded.month THEN relay_quota.month_units + excluded.month_units
      ELSE excluded.month_units
    END
  WHERE
    (relay_quota.day <> excluded.day OR relay_quota.day_units + excluded.day_units <= ?5)
    AND (
      relay_quota.month <> excluded.month
      OR relay_quota.month_units + excluded.month_units <= ?6
    )
  RETURNING day, day_requests, day_units, month, month_units
`;

function periods(now) {
  const iso = new Date(now).toISOString();
  return { day: iso.slice(0, 10), month: iso.slice(0, 7) };
}

export function dailyRequestLimit(now = Date.now()) {
  return periods(now).day === TEMPORARY_DAILY_REQUEST_LIMIT_DAY
    ? TEMPORARY_DAILY_REQUEST_LIMIT
    : DAILY_REQUEST_LIMIT;
}

function retryAt(reason, now) {
  const date = new Date(now);
  if (reason === 'monthly') {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
  }
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString();
}

export async function consumeRelayQuota(db, kind = 'http', now = Date.now(), requestCount = 1) {
  if (!db) return { allowed: false, reason: 'unavailable' };
  const maximum = kind === 'websocket' ? WEBSOCKET_QUOTA_MAX_RESERVATION : 1;
  if (!Number.isSafeInteger(requestCount) || requestCount < 1 || requestCount > maximum) {
    return { allowed: false, reason: 'unavailable' };
  }
  const { day, month } = periods(now);
  const dailyUnitLimit = dailyRequestLimit(now) * HTTP_BILLABLE_UNITS;
  const units = (kind === 'websocket' ? WEBSOCKET_BILLABLE_UNITS : HTTP_BILLABLE_UNITS)
    * requestCount;

  try {
    const row = await db.prepare(CONSUME_SQL).bind(
      day,
      month,
      requestCount,
      units,
      dailyUnitLimit,
      MONTHLY_BILLABLE_UNIT_LIMIT,
    ).first();
    if (row) return { allowed: true, ...row };

    const current = await db.prepare(
      'SELECT day, day_requests, day_units, month, month_units FROM relay_quota WHERE singleton = 1',
    ).first();
    const reason = current?.day === day && current.day_units + units > dailyUnitLimit
      ? 'daily'
      : 'monthly';
    return { allowed: false, reason, retryAt: retryAt(reason, now), ...current };
  } catch (error) {
    console.error(JSON.stringify({
      service: 'mobile-relay',
      event: 'quota.unavailable',
      error: error instanceof Error ? error.message : String(error),
    }));
    return { allowed: false, reason: 'unavailable' };
  }
}

export async function acquireRelayCircuit(db, now = Date.now()) {
  if (!db) return { allowed: false };
  try {
    const current = await db.prepare(
      'SELECT retry_at FROM relay_circuit WHERE singleton = 1',
    ).first();
    const retryAt = Number(current?.retry_at || 0);
    if (!retryAt) return { allowed: true, probe: false };
    if (retryAt > now) {
      return { allowed: false, retryAt: new Date(retryAt).toISOString() };
    }

    const claimed = await db.prepare(`
      UPDATE relay_circuit
      SET retry_at = ?1
      WHERE singleton = 1 AND retry_at > 0 AND retry_at <= ?2
      RETURNING retry_at
    `).bind(now + CIRCUIT_PROBE_LEASE_MS, now).first();
    if (claimed) return { allowed: true, probe: true };

    const latest = await db.prepare(
      'SELECT retry_at FROM relay_circuit WHERE singleton = 1',
    ).first();
    return {
      allowed: false,
      ...(latest?.retry_at ? { retryAt: new Date(Number(latest.retry_at)).toISOString() } : {}),
    };
  } catch (error) {
    console.error(JSON.stringify({
      service: 'mobile-relay',
      event: 'circuit.unavailable',
      error: error instanceof Error ? error.message : String(error),
    }));
    return { allowed: false };
  }
}

export async function openRelayCircuit(db, now = Date.now()) {
  const retryAt = now + DURABLE_OBJECTS_BACKOFF_MS;
  await db.prepare(`
    INSERT INTO relay_circuit (singleton, retry_at) VALUES (1, ?1)
    ON CONFLICT(singleton) DO UPDATE SET retry_at = excluded.retry_at
  `).bind(retryAt).run();
  return retryAt;
}

export async function closeRelayCircuit(db) {
  await db.prepare(
    'UPDATE relay_circuit SET retry_at = 0 WHERE singleton = 1',
  ).run();
}
