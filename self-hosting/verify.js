#!/usr/bin/env node

// Live integration check: requires running services and an installed, signed-in Codex CLI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseEnv } = require('node:util');

async function verify(root = path.resolve(__dirname, '..')) {
  const { chromium, expect } = require(path.join(root, 'web/node_modules/@playwright/test'));
  const { createHeadlessHost, loadIdentity } = require(path.join(root, 'src/infrastructure/headless/headless-runtime'));
  const env = parseEnv(fs.readFileSync(path.join(root, 'self-hosting/host.env'), 'utf8'));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-self-host-check-'));
  const project = path.join(scratch, 'cas-cloud-check');
  const dataPath = path.join(scratch, 'state');
  const evidence = path.resolve(process.env.CAS_SELF_HOST_EVIDENCE || path.join(root, 'self-hosting/verification'));
  fs.mkdirSync(project);
  fs.mkdirSync(dataPath);
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), '# CAS Cloud integration check\nA disposable project for the live browser-to-agent check.\n');
  const host = createHeadlessHost({
    projectPaths: [project], dataPath,
    identity: loadIdentity(path.join(dataPath, 'identity.json')),
    getToken: () => env.CAS_ACCESS_TOKEN,
    backendUrl: env.CAS_BACKEND_URL,
    version: require(path.join(root, 'package.json')).version,
  });
  const faults = [];
  const network = [];
  let browser;
  host.relay.on('event', (event) => {
    if (event.kind === 'pair.scanned') {
      host.relay.confirmPairing(event.pairingId, true).catch((error) => faults.push(error.message));
    }
  });
  try {
    for (const origin of [env.CAS_BACKEND_URL, env.CAS_PAIRING_CODE_ORIGIN]) {
      assert.equal((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(10000) })).status, 200);
    }
    await host.start();
    const pairing = await host.relay.createPairing();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', (error) => faults.push(error.message));
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (['xhr', 'fetch'].includes(response.request().resourceType())) {
        network.push({ origin: url.origin, path: url.pathname.replace(/(pairing-code\/).*/, '$1<redacted>'), status: response.status() });
      }
    });
    await page.goto(env.CAS_WEB_ORIGIN);
    await page.getByRole('textbox', { name: 'Pairing code, first four characters' }).fill(pairing.pairingCode);
    await page.getByRole('button', { name: 'Connect with pairing code' }).click();
    await page.getByRole('tab', { name: 'Projects', exact: true }).click({ timeout: 30000 });
    await expect(page.getByRole('button', { name: 'Open project cas-cloud-check' })).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Create a new session' }).click();
    await page.getByRole('textbox', { name: 'First message for the new session' })
      .fill('Reply with CAS_CLOUD_SELF_HOST_OK, followed by a short explanation of what self-hosting means. Do not use tools or modify files.');
    await page.getByRole('button', { name: 'Create and send', exact: true }).click();
    await expect(page.getByText(/^CAS_CLOUD_SELF_HOST_OK/)).toBeVisible({ timeout: 120000 });
    await expect(page.getByLabel('Message Codex')).toBeVisible();
    await page.screenshot({ path: path.join(evidence, 'web-live-codex.png'), fullPage: true });
    await page.reload();
    await page.getByRole('button', { name: /^Codex, / }).click({ timeout: 30000 });
    await expect(page.getByText(/^CAS_CLOUD_SELF_HOST_OK/)).toBeVisible({ timeout: 30000 });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByText(/^CAS_CLOUD_SELF_HOST_OK/)).toBeVisible();
    await expect(page.getByTestId('starting-chat-skeleton')).toBeHidden();
    await page.screenshot({ path: path.join(evidence, 'web-mobile-reconnected.png'), fullPage: true });
    assert.deepEqual(faults, []);
    assert.ok(network.some((item) => item.origin === env.CAS_PAIRING_CODE_ORIGIN && item.status === 200));
    assert.ok(network.some((item) => item.origin === env.CAS_BACKEND_URL && item.status === 200));
    assert.equal(network.some((item) => /codeagentswarm\.(com|app)|codeagentswarm.*railway\.app/.test(item.origin)), false);
    const result = { ok: true, checks: ['own API and relay health', 'short-code pairing', 'real host project', 'real Codex response', 'browser reload', 'mobile viewport'], network, faults };
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ ok: true, checks: result.checks, evidence }));
    return result;
  } finally {
    await browser?.close();
    await host.stop({ persistState: false });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) verify(process.argv[2]).catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { verify };
