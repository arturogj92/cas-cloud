const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const packageRoot = path.resolve(__dirname, '..');
const manifest = require(path.join(packageRoot, 'package.json'));

test('ships the Linux user-service and local smoke check', () => {
  assert.deepStrictEqual(manifest.files.sort(), [
    'LICENSE',
    'README.md',
    'THIRD_PARTY_NOTICES.md',
    'dist/*.js',
    'scripts/cas-cli-smoke.sh',
    'systemd/cas-cli.service.example',
  ]);
  assert.ok(fs.existsSync(path.join(packageRoot, 'dist', 'mcp-stdio-server.js')));
  assert.ok(fs.existsSync(path.join(packageRoot, 'dist', 'antigravity-mcp-launcher.js')));
  assert.match(fs.readFileSync(path.join(packageRoot, 'systemd', 'cas-cli.service.example'), 'utf8'), /KillSignal=SIGTERM/);
  assert.match(fs.readFileSync(path.join(packageRoot, 'scripts', 'cas-cli-smoke.sh'), 'utf8'), /:memory:/);
});
