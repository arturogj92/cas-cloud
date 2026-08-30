#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const qrcode = require('qrcode');
const { AGENT_BINARIES, AGENT_IDS, HeadlessProviderService } = require('../infrastructure/headless/headless-provider-service');
const { setupHeadlessMcp } = require('../infrastructure/headless/headless-mcp-setup');
const { updateInstallation } = require('../infrastructure/headless/headless-updater');
const { pairingPayload } = require('../infrastructure/mobile/mobile-pairing-ipc');
const { mobileWebOrigin } = require('../infrastructure/mobile/mobile-build-channel');
const { requestHeadlessBridge } = require('../infrastructure/headless/headless-session-bridge');
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
const DEFAULT_PAIRING_CODE_ORIGIN = 'https://codeagentswarm-connect.elcaminodelprogramadorweb.workers.dev';

function help() {
  return `CAS CLI ${version}

Usage:
  npx @codeagentswarm/cas-cloud serve [--project PATH ...] [--projects-root PATH ...]
  cas-cli serve [--project PATH ...] [--projects-root PATH ...] [--channel production|development]
  cas-cli setup
  cas-cli doctor
  cas-cli update
  cas-cli link PAIRING_CODE
  cas-cli remote-status
  cas-cli unlink
  cas-cli --version

setup installs every supported agent CLI and its CodeAgentSwarm MCP. serve checks that setup automatically,
starts CAS Cloud, connects it to the relay and
prints a one-time QR and pairing code for a CodeAgentSwarm client. Projects and authorized clone roots are
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
  if (!['serve', 'setup', 'doctor', 'update', 'help', 'link', 'remote-status', 'unlink'].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  const pairingInput = command === 'link' ? parsed.positionals.shift() : null;
  if (command === 'link' && !pairingInput) throw new Error('A pairing code is required');
  if (parsed.positionals.length) throw new Error(`Unexpected argument: ${parsed.positionals[0]}`);
  if (!['production', 'development'].includes(parsed.values.channel)) {
    throw new Error('Channel must be production or development');
  }
  const { ['projects-root']: projectsRoot, ...values } = parsed.values;
  return { command, ...values, projectsRoot, ...(pairingInput ? { pairingInput } : {}) };
}

async function resolvePairingInput(raw, fetchImpl = globalThis.fetch) {
  const compact = String(raw || '').trim().toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(compact)) throw new Error('This pairing code is not valid');
  const code = `${compact.slice(0, 4)}-${compact.slice(4)}`;
  const origin = new URL(process.env.CAS_PAIRING_CODE_ORIGIN || DEFAULT_PAIRING_CODE_ORIGIN);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local)) || origin.username || origin.password) {
    throw new Error('The pairing service is not secure');
  }
  try {
    const response = await fetchImpl(`${origin.origin}/api/mobile/pairing-code/${encodeURIComponent(code)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error();
    const body = await response.json();
    if (typeof body.pairingUri !== 'string') throw new Error();
    return body.pairingUri;
  } catch (_) {
    throw new Error('This pairing code is invalid or has expired');
  }
}

async function linkRemoteRuntime(pairingInput, { output = console.log, request = requestHeadlessBridge } = {}) {
  const pairing = await resolvePairingInput(pairingInput);
  await request(appDataPath(), 'POST', '/admin/remote-runtime/pair', { pairing });
  const deadline = Date.now() + 120000;
  let shownChallenge = null;
  while (Date.now() < deadline) {
    const state = await request(appDataPath(), 'GET', '/admin/remote-runtime');
    if (state.phase === 'online') {
      output(`Connected to ${state.runtime?.name || 'the Mac'} ✓`);
      return state;
    }
    if (state.phase === 'confirming' && state.challenge?.code && state.challenge.code !== shownChallenge) {
      shownChallenge = state.challenge.code;
      output(`Verification code: ${shownChallenge}. Confirm it on the Mac.`);
    }
    if (state.error && !['connecting', 'confirming', 'syncing'].includes(state.phase)) throw new Error(state.error);
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error('Pairing timed out before it was confirmed on the Mac');
}

async function printRemoteStatus({ output = console.log, request = requestHeadlessBridge } = {}) {
  const state = await request(appDataPath(), 'GET', '/admin/remote-runtime');
  output(state.phase === 'online'
    ? `Mac link: online · ${state.runtime?.name || state.runtime?.id}`
    : `Mac link: ${state.phase}${state.error ? ` · ${state.error}` : ''}`);
  return state;
}

async function unlinkRemoteRuntime({ output = console.log, request = requestHeadlessBridge } = {}) {
  await request(appDataPath(), 'DELETE', '/admin/remote-runtime');
  output('Mac link removed ✓');
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
  const output = options.output || console.log;
  const mcpFailures = mcp.mcpFailures || mcp.failures || [];
  const instructionFailures = mcp.instructionFailures || [];
  if (mcpFailures.length) {
    output(`CodeAgentSwarm MCP conflicts left unchanged: ${mcpFailures.map(({ agent }) => agent).join(', ')}`);
  } else {
    output('CodeAgentSwarm MCP: configured for every agent ✓');
  }
  if (instructionFailures.length) {
    output(`CodeAgentSwarm title instructions failed: ${instructionFailures.map(({ agent }) => agent).join(', ')}`);
  } else {
    output('CodeAgentSwarm title instructions: configured for every MCP-enabled agent ✓');
  }
  return { ...providers, mcp };
}

async function serve({ project: projectPaths = [], projectsRoot: projectRoots = [], channel }) {
  let printPairing;
  let pairingRefresh = Promise.resolve();
  let refreshPending = false;
  const refreshPairing = () => {
    if (!printPairing) {
      refreshPending = true;
      return;
    }
    pairingRefresh = pairingRefresh
      .then(() => printPairing())
      .catch((error) => console.error(`Pairing refresh failed: ${error.message}`));
  };
  process.on('SIGUSR1', refreshPairing);

  try {
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
          console.log(`Approving ${event.device?.name || 'mobile device'} with verification code ${code}.`);
          await host.relay.confirmPairing(event.pairingId, true);
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
    console.log(`\nCAS Cloud is serving ${host.projects.length} registered project${host.projects.length === 1 ? '' : 's'}`);
    console.log(`Runtime: ${host.identity.runtimeId}`);
    printPairing = async ({ includeQr = false } = {}) => {
      const pairing = await host.relay.createPairing();
      console.log(`Pairing expires: ${new Date(pairing.expiresAt).toLocaleString()}`);
      if (includeQr) {
        const link = pairingPayload(pairing, mobileWebOrigin(channel));
        console.log(await qrcode.toString(link, { type: 'terminal', small: true, errorCorrectionLevel: 'L' }));
        console.log(`Pairing code: ${pairing.pairingCode}`);
        console.log(link);
        return;
      }
      console.log(`Pairing code: ${pairing.pairingCode}`);
    };
    pairingRefresh = printPairing({ includeQr: true });
    await pairingRefresh;
    if (refreshPending) {
      refreshPending = false;
      refreshPairing();
    }
    console.log('\nPress Ctrl+C to stop. Send SIGUSR1 to print a fresh pairing code without restarting.');

    const stop = async () => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGUSR1', refreshPairing);
      await pairingRefresh;
      await host.stop();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    process.removeListener('SIGUSR1', refreshPairing);
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  if (options.version) return console.log(version);
  if (options.help || options.command === 'help') return console.log(help());
  if (options.command === 'doctor') return doctor();
  if (options.command === 'setup') return setupCloud();
  if (options.command === 'update') return updateInstallation();
  if (options.command === 'link') return linkRemoteRuntime(options.pairingInput);
  if (options.command === 'remote-status') return printRemoteStatus();
  if (options.command === 'unlink') return unlinkRemoteRuntime();
  await serve(options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`CAS CLI: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  AGENT_BINARIES,
  doctor,
  help,
  linkRemoteRuntime,
  main,
  parseCliArgs,
  printRemoteStatus,
  resolvePairingInput,
  serve,
  setupCloud,
  setupProviders,
  unlinkRemoteRuntime,
  updateInstallation,
};
