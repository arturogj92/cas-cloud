import assert from 'node:assert/strict';
import test from 'node:test';

test('backs off after Cloudflare keeps a paid account on the Durable Objects free-tier stop', async () => {
  const firstWorker = (await import(`../src/index.js?first=${Date.now()}`)).default;
  const secondWorker = (await import(`../src/index.js?second=${Date.now()}`)).default;
  let durableFetches = 0;
  let durableBlocked = true;
  let quotaWrites = 0;
  let circuitRetryAt = 0;
  const env = {
    MOBILE_RELAY_SECRET: 's'.repeat(32),
    RELAY_QUOTA: {
      prepare: (sql) => {
        if (sql.includes('SELECT retry_at FROM relay_circuit')) {
          return { first: async () => ({ retry_at: circuitRetryAt }) };
        }
        if (sql.includes('INSERT INTO relay_circuit')) {
          return {
            bind: (retryAt) => ({
              run: async () => { circuitRetryAt = retryAt; },
            }),
          };
        }
        if (sql.includes('RETURNING retry_at')) {
          return {
            bind: (leaseUntil, now) => ({
              first: async () => {
                if (!circuitRetryAt || circuitRetryAt > now) return null;
                circuitRetryAt = leaseUntil;
                return { retry_at: circuitRetryAt };
              },
            }),
          };
        }
        if (sql.includes('UPDATE relay_circuit SET retry_at = 0')) {
          return { run: async () => { circuitRetryAt = 0; } };
        }
        return {
          bind: () => ({
            first: async () => {
              quotaWrites += 1;
              return {
                day: '2026-09-01',
                day_requests: quotaWrites,
                day_units: 20,
                month: '2026-09',
                month_units: 20,
              };
            },
          }),
        };
      },
    },
    RUNTIMES: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async () => {
          durableFetches += 1;
          if (durableBlocked) {
            throw new Error('Exceeded allowed volume of requests in Durable Objects free tier.');
          }
          return new Response('recovered', { status: 410 });
        },
      }),
    },
  };
  const request = new Request('https://relay.test/api/mobile/pairing-code/ABCDEFGH');

  const first = await firstWorker.fetch(request, env);
  const second = await secondWorker.fetch(request, env);

  assert.equal(first.status, 503);
  assert.equal(second.status, 503);
  assert.equal(first.headers.get('retry-after'), '60');
  assert.equal(durableFetches, 1);
  assert.equal(quotaWrites, 1);

  circuitRetryAt = Date.now() - 1;
  durableBlocked = false;
  const recovered = await secondWorker.fetch(request, env);
  assert.equal(recovered.status, 410);
  assert.equal(circuitRetryAt, 0);
  assert.equal(durableFetches, 2);
  assert.equal(quotaWrites, 2);
});
