const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const packageRoot = path.resolve(__dirname, '..');
const manifest = require(path.join(packageRoot, 'package.json'));

test('declares the noncommercial source license explicitly', () => {
  assert.strictEqual(manifest.license, 'PolyForm-Noncommercial-1.0.0');
  assert.match(
    fs.readFileSync(path.join(packageRoot, 'NOTICE'), 'utf8').trim(),
    /^Required Notice: Copyright 2026 Arturo Garcia\. Commercial licensing: hello@codeagentswarm\.com\.$/,
  );
});

test('ships the Linux user-service and local smoke check', () => {
  assert.deepStrictEqual(manifest.files.sort(), [
    'LICENSE',
    'NOTICE',
    'README.md',
    'THIRD_PARTY_NOTICES.md',
    'caddy/Caddyfile.preview.example',
    'dist/*.js',
    'dist/templates/*.md',
    'scripts/cas-cli-smoke.sh',
    'systemd/cas-cli-update.service.example',
    'systemd/cas-cli-update.timer.example',
    'systemd/cas-cli.service.example',
    'systemd/cas-preview.service.example',
  ]);
  assert.ok(fs.existsSync(path.join(packageRoot, 'dist', 'mcp-stdio-server.js')));
  assert.ok(fs.existsSync(path.join(packageRoot, 'dist', 'antigravity-mcp-launcher.js')));
  assert.ok(fs.existsSync(path.join(packageRoot, 'dist', 'cas-preview.js')));
  assert.ok(fs.existsSync(path.join(packageRoot, 'dist', 'templates', 'codex-md-titles-section.md')));
  assert.match(fs.readFileSync(path.join(packageRoot, 'systemd', 'cas-cli.service.example'), 'utf8'), /KillSignal=SIGTERM/);
  assert.match(fs.readFileSync(path.join(packageRoot, 'systemd', 'cas-cli-update.service.example'), 'utf8'), /cas-cli update/);
  assert.match(fs.readFileSync(path.join(packageRoot, 'systemd', 'cas-cli-update.service.example'), 'utf8'), /TimeoutStartSec=infinity/);
  assert.match(fs.readFileSync(path.join(packageRoot, 'systemd', 'cas-cli-update.timer.example'), 'utf8'), /Persistent=true/);
  assert.match(fs.readFileSync(path.join(packageRoot, 'systemd', 'cas-preview.service.example'), 'utf8'), /KillMode=control-group/);
  assert.match(fs.readFileSync(path.join(packageRoot, 'caddy', 'Caddyfile.preview.example'), 'utf8'), /127\.0\.0\.1:41820/);
  assert.match(fs.readFileSync(path.join(packageRoot, 'scripts', 'cas-cli-smoke.sh'), 'utf8'), /:memory:/);
});
