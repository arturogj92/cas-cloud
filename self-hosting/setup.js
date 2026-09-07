#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseEnv } = require('node:util');
const { execFileSync } = require('node:child_process');
const readline = require('node:readline/promises');

function configure(root, domain = null) {
  if (domain && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new Error('Enter a domain such as example.com, without a scheme or path');
  }
  const apiFile = path.join(root, 'control-plane/.env');
  const previous = fs.existsSync(apiFile) ? parseEnv(fs.readFileSync(apiFile, 'utf8')) : {};
  const token = previous.CAS_ACCESS_TOKEN || crypto.randomBytes(32).toString('base64url');
  const secret = previous.MOBILE_RELAY_SECRET || crypto.randomBytes(32).toString('base64url');
  if (!/^[A-Za-z0-9_-]{43,}$/.test(token) || secret.length < 32 || token === secret) {
    throw new Error('Existing credentials are invalid; remove placeholder values from control-plane/.env and rerun setup');
  }
  const relay = domain ? `https://relay.${domain}` : 'http://127.0.0.1:8787';
  const api = domain ? `https://api.${domain}` : 'http://127.0.0.1:8788';
  const web = domain ? `https://web.${domain}` : 'http://localhost:8081';
  const write = (file, values) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const contents = Object.entries(values).map(([key, value]) => {
      if (/[\r\n]/.test(String(value))) throw new Error(`Invalid multiline value for ${key}`);
      return `${key}=${JSON.stringify(String(value))}`;
    }).join('\n') + '\n';
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
  };
  write('control-plane/.env', {
    ...previous, CAS_ACCESS_TOKEN: token, MOBILE_RELAY_SECRET: secret,
    MOBILE_RELAY_URL: relay, CAS_WEB_ORIGIN: web,
    CAS_CLOUD_DATABASE: previous.CAS_CLOUD_DATABASE || './data/devices.sqlite', HOST: '127.0.0.1', PORT: 8788,
  });
  write('relay/.dev.vars', { MOBILE_RELAY_SECRET: secret });
  write('web/.env.local', { EXPO_PUBLIC_MOBILE_RELAY_URL: relay });
  write('self-hosting/host.env', {
    CAS_ACCESS_TOKEN: token, CAS_BACKEND_URL: api, CAS_WEB_ORIGIN: web, CAS_PAIRING_CODE_ORIGIN: relay,
  });
  write('self-hosting/.env', {
    CAS_WEB_DOMAIN: domain ? `web.${domain}` : 'localhost',
    CAS_API_DOMAIN: domain ? `api.${domain}` : 'localhost', MOBILE_RELAY_URL: relay,
  });
  return { web, api, relay, secret };
}

async function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || !['--local', '--vps'].includes(args[0])) {
    throw new Error('Usage: node self-hosting/setup.js --local|--vps (Node 22 and Docker Compose required)');
  }
  const root = path.resolve(__dirname, '..');
  const run = (command, argv, options = {}) => execFileSync(command, argv, {
    cwd: root, stdio: 'inherit', ...options,
  });
  run('docker', ['compose', 'version']);
  run('docker', ['info', '--format', '{{.ServerVersion}}']);
  let domain = null;
  if (args[0] === '--vps') {
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      domain = (await prompt.question('Your domain (example.com): ')).trim().toLowerCase();
      if (!domain) throw new Error('A domain is required for VPS hosting');
    } finally { prompt.close(); }
  }
  const config = configure(root, domain);
  if (domain) {
    run('npm', ['ci', '--prefix', 'relay']);
    const relayRoot = path.join(root, 'relay');
    const wrangler = path.join(relayRoot, 'node_modules/wrangler/bin/wrangler.js');
    const worker = (argv, options = {}) => run(process.execPath, [wrangler, ...argv], { cwd: relayRoot, ...options });
    if (!process.env.CLOUDFLARE_API_TOKEN) worker(['login']);
    const filename = path.join(relayRoot, 'wrangler.jsonc');
    const workerConfig = JSON.parse(fs.readFileSync(filename, 'utf8'));
    workerConfig.routes = [{ pattern: `relay.${domain}`, custom_domain: true }];
    fs.writeFileSync(filename, JSON.stringify(workerConfig, null, 2) + '\n');
    if (workerConfig.d1_databases[0].database_id === '00000000-0000-0000-0000-000000000000') {
      worker(['d1', 'create', workerConfig.d1_databases[0].database_name, '--binding', 'RELAY_QUOTA', '--update-config']);
    }
    worker(['d1', 'migrations', 'apply', 'RELAY_QUOTA', '--remote']);
    worker(['secret', 'put', 'MOBILE_RELAY_SECRET'], { input: config.secret + '\n', stdio: ['pipe', 'inherit', 'inherit'] });
    worker(['deploy']);
    console.log(`Point web.${domain} and api.${domain} DNS records at this VPS; ports 80 and 443 must be reachable.`);
  }
  run('docker', ['compose', '-f', domain ? 'compose.yaml' : 'compose.local.yaml', 'up', '--build', '-d'], {
    cwd: path.join(root, 'self-hosting'),
  });
  if (!domain) {
    for (const url of [config.web, `${config.api}/health`, `${config.relay}/health`]) {
      let ready = false;
      for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
        try { ready = (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!ready) throw new Error(`Service did not start: ${url}. Run docker compose -f compose.local.yaml logs from self-hosting/.`);
    }
  }
  console.log(`\nWeb: ${config.web}\nStart the agent host from this repository:\n  npm ci && npm run build\n  node --env-file=self-hosting/host.env dist/cas.js serve --project /path/to/project\nSecrets are saved locally with owner-only permissions; rerunning setup preserves them.`);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { configure };
