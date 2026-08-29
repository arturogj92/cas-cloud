'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REQUEST_MAX_AGE_MS = 5 * 60 * 1000;

function requestDirectory(home = os.homedir()) {
  return path.join(home, '.codeagentswarm', 'sandbox-project-requests');
}

function writeSandboxProjectRequest({ terminalUuid, terminalId }, options = {}) {
  if (!terminalUuid) throw new Error('A stable terminal UUID is required for Sandbox promotion');

  const directory = requestDirectory(options.home);
  fs.mkdirSync(directory, { recursive: true });
  const requestId = options.requestId || crypto.randomUUID();
  const file = path.join(directory, `${requestId}.json`);
  const temporaryFile = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify({
      type: 'sandbox_project_request',
      terminal_id: terminalId,
      terminal_uuid: terminalUuid,
      timestamp: new Date(options.now || Date.now()).toISOString(),
    }), { flag: 'wx' });
    fs.renameSync(temporaryFile, file);
  } finally {
    fs.rmSync(temporaryFile, { force: true });
  }
  return file;
}

function claimSandboxProjectRequests(quadrantByUuid, options = {}) {
  const directory = requestDirectory(options.home);
  if (!fs.existsSync(directory)) return [];

  const now = options.now || Date.now();
  const requests = [];
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(directory, name);
    let request;
    try {
      request = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      fs.rmSync(file, { force: true });
      continue;
    }

    const timestamp = new Date(request.timestamp).getTime();
    if (!Number.isFinite(timestamp) || now - timestamp > REQUEST_MAX_AGE_MS) {
      fs.rmSync(file, { force: true });
      continue;
    }

    const quadrant = quadrantByUuid.get(request.terminal_uuid);
    if (quadrant === undefined) continue;

    const claimed = `${file}.${process.pid}.claimed`;
    try {
      fs.renameSync(file, claimed);
      requests.push({ ...request, terminal_id: quadrant + 1 });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    } finally {
      fs.rmSync(claimed, { force: true });
    }
  }
  return requests;
}

module.exports = {
  REQUEST_MAX_AGE_MS,
  claimSandboxProjectRequests,
  requestDirectory,
  writeSandboxProjectRequest,
};
