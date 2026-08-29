#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { parseArgs } = require('util');
const qrcode = require('qrcode');
const { AGENT_BINARIES, AGENT_IDS, HeadlessProviderService } = require('../infrastructure/headless/headless-provider-service');
const { setupHeadlessMcp } = require('../infrastructure/headless/headless-mcp-setup');
const { pairingPayload } = require('../infrastructure/mobile/mobile-pairing-ipc');
const { mobileWebOrigin } = require('../infrastructure/mobile/mobile-build-channel');
const {
  DEFAULT_BACKEND_URL,
  appDataPath,
  createAccessTokenProvider,
  createHeadlessHost,
  loadIdentity,
  resolveProject,
} = require('../infrastructure/headless/headless-runtime');
const version = typeof CAS_CLI_BUNDLED_VERSION === 'string'
  ? CAS_CLI_BUNDLED_VERSION
  : JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version;

function help() {
  return `CAS CLI ${version}

Usage:
  npx codeagentswarm cloud [--project PATH ...] [--projects-root PATH ...]
  cas-cli serve [--project PATH ...] [--projects-root PATH ...] [--channel production|development]
  cas-cli setup
  cas-cli doctor
  cas-cli --version

setup installs every supported agent CLI and its CodeAgentSwarm MCP. serve checks that setup automatically,
starts CAS Cloud, connects it to the relay and
prints a one-time QR for a CodeAgentSwarm client. Projects and authorized clone roots are
host-local configuration; either repeatable flag may be omitted.
`;
}

function parseCliArgs(argv) {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      channel: { type: 'string', default: 'production' },
      help: { type: 'boolean', short: 'h' },
      project: { type: 'string', multiple: true, default: [] },
      'projects-root': { type: 'string', multiple: true, default: [] },
      version: { type: 'boolean', short: 'v' },
    },
    strict: true,
  });
  const requestedCommand = parsed.positionals.shift() || 'serve';
  const command = requestedCommand === 'cloud' ? 'serve' : requestedCommand;
  if (parsed.positionals.length) throw new Error(`Unexpected argument: ${parsed.positionals[0]}`);
  if (!['serve', 'setup', 'doctor', 'help'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (!['production', 'development'].includes(parsed.values.channel)) {
    throw new Error('Channel must be production or development');
  }
  const { ['projects-root']: projectsRoot, ...values } = parsed.values;
  return { command, ...values, projectsRoot };
}

async function doctor() {
  const supportedPlatform = process.platform === 'darwin' || process.platform === 'linux';
  console.log(`Platform: ${process.platform} ${supportedPlatform ? '✓' : 'unsupported'}`);
  console.log(`Node: ${process.version} ${Number(process.versions.node.split('.')[0]) >= 20 ? '✓' : '(Node 20+ required)'}`);
  console.log(`CAS account: ${process.env.CAS_ACCESS_TOKEN || fs.existsSync(path.join(appDataPath(), 'auth-data.json')) ? 'available ✓' : 'sign in required'}`);
  const providers = new HeadlessProviderService();
  const inspected = await Promise.all(AGENT_IDS.map((agent) => providers.inspect(agent, { includePath: true })));
  for (const provider of inspected) {
    const agent = provider.id;
    console.log(`${agent}: ${provider.installed ? `${provider.path}${provider.version ? ` (${provider.version})` : ''}` : 'not found'}${provider.login.status?.loggedIn === true ? ' · signed in ✓' : ''}`);
  }
  providers.stop();
}

async function setupProviders({ providerService = new HeadlessProviderService(), output = console.log } = {}) {
  const failed = [];
  try {
    for (const agent of AGENT_IDS) {
      if (providerService.executable(agent)) {
        output(`${agent}: installed ✓`);
        continue;
      }
      output(`${agent}: installing…`);
      try {
        const result = await providerService.install(agent, ({ stage }) => {
          if (stage && stage !== 'installing') output(`${agent}: ${stage}`);
        });
        if (!result?.success) failed.push(agent);
        else output(`${agent}: installed ✓`);
      } catch (error) {
        failed.push(agent);
        output(`${agent}: ${error.message}`);
      }
    }
  } finally {
    providerService.stop?.();
  }
  if (failed.length) throw new Error(`CAS Cloud could not install: ${failed.join(', ')}`);
  return { installed: [...AGENT_IDS] };
}

function mcpAsset(name) {
  const bundled = path.join(__dirname, name);
  return fs.existsSync(bundled)
    ? bundled
    : path.join(__dirname, '..', 'infrastructure', 'mcp', name);
}

async function setupCloud(options = {}) {
  const providers = await setupProviders(options);
  const mcp = await setupHeadlessMcp({
    serverSource: mcpAsset('mcp-stdio-server.js'),
    launcherSource: mcpAsset('antigravity-mcp-launcher.js'),
  });
  (options.output || console.log)('CodeAgentSwarm MCP: configured for every agent ✓');
  return { ...providers, mcp };
}

async function serve({ project: projectPaths = [], projectsRoot: projectRoots = [], channel }) {
  await setupCloud();
  const projects = projectPaths.map((projectPath) => resolveProject(projectPath));
  const roots = projectRoots.map((rootPath) => resolveProject(rootPath).path);
  const backendUrl = process.env.CAS_BACKEND_URL || DEFAULT_BACKEND_URL;
  const host = createHeadlessHost({
    projectPaths: projects.map((project) => project.path),
    projectRoots: roots,
    getToken: await createAccessTokenProvider({ backendUrl }),
    identity: loadIdentity(),
    backendUrl,
    channel,
    version,
  });

  host.relay.on('status', ({ status }) => console.log(`Relay: ${status}`));
  host.relay.on('diagnostic', ({ event }) => console.log(`Relay diagnostic: ${event}`));
  host.relay.on('event', (event) => {
    void (async () => {
      if (event.kind === 'pair.scanned') {
        const code = String(event.verificationCode || '').padStart(6, '0');
        const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await terminal.question(`Allow ${event.device?.name || 'mobile device'}? Code ${code} [y/N] `);
        terminal.close();
        await host.relay.confirmPairing(event.pairingId, /^y(es)?$/i.test(answer.trim()));
      } else if (event.kind === 'pair.completed') {
        console.log(`${event.device?.name || 'Mobile device'} connected.`);
      } else if (event.kind === 'mobile.connected') {
        console.log(`${event.device?.name || 'Mobile device'} online.`);
      } else if (event.kind === 'mobile.disconnected') {
        console.log('Mobile device disconnected; the relay will keep listening.');
      }
    })().catch((error) => console.error(`Pairing failed: ${error.message}`));
  });

  await host.start();
  const pairing = await host.relay.createPairing();
  const link = pairingPayload(pairing, mobileWebOrigin(channel));
  console.log(`\nCAS Cloud is serving ${host.projects.length} registered project${host.projects.length === 1 ? '' : 's'}`);
  console.log(`Runtime: ${host.identity.runtimeId}`);
  console.log(`Pairing expires: ${new Date(pairing.expiresAt).toLocaleString()}`);
  console.log(await qrcode.toString(link, { type: 'terminal', small: true, errorCorrectionLevel: 'L' }));
  console.log(link);
  console.log('\nPress Ctrl+C to stop.');

  const stop = async () => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await host.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  if (options.version) return console.log(version);
  if (options.help || options.command === 'help') return console.log(help());
  if (options.command === 'doctor') return doctor();
  if (options.command === 'setup') return setupCloud();
  await serve(options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`CAS CLI: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { AGENT_BINARIES, doctor, help, main, parseCliArgs, serve, setupCloud, setupProviders };
