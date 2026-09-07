'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function locationError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Location discovery is an explicit paired-owner action, separate from browsing
// inside an already authorized project root. Only owner location discovery may
// accept an absolute path; project commands still use opaque roots and child names.
class RemoteProjectLocations {
  constructor() {
    this.locations = new Map();
  }

  remember(candidate) {
    const resolved = fs.realpathSync(candidate);
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) throw new Error('Choose an existing folder');
    let locationId = [...this.locations].find(([, entry]) => entry.path === resolved)?.[0];
    const previous = this.locations.get(locationId);
    if (previous && (previous.dev !== stat.dev || previous.ino !== stat.ino)) {
      this.locations.delete(locationId);
      locationId = null;
    }
    if (!locationId) {
      // ponytail: bound discovery tokens; revisit the folder after 4096 candidates.
      if (this.locations.size >= 4096) this.locations.delete(this.locations.keys().next().value);
      locationId = crypto.randomBytes(18).toString('base64url');
      this.locations.set(locationId, { path: resolved, dev: stat.dev, ino: stat.ino });
    }
    return { locationId, name: path.basename(resolved) || path.parse(resolved).root };
  }

  resolve(locationId) {
    const entry = this.locations.get(locationId);
    if (!entry) throw locationError('location_expired', 'This folder selection expired. Browse again.');
    try {
      const stat = fs.lstatSync(entry.path);
      if (!stat.isDirectory() || fs.realpathSync(entry.path) !== entry.path
        || stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error();
    } catch (_) { throw locationError('location_expired', 'The folder changed. Browse again.'); }
    return entry.path;
  }

  writable(locationId) {
    const resolved = this.resolve(locationId);
    const stat = fs.statSync(resolved);
    const uid = typeof process.geteuid === 'function' ? process.geteuid() : null;
    if (resolved === path.parse(resolved).root
      || (uid !== null && (stat.uid !== uid || (stat.mode & 0o022) !== 0 || (stat.mode & 0o200) === 0))) {
      throw locationError('location_permission_denied', 'Choose a private folder owned by the remote service user, not a whole drive.');
    }
    try { fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK); } catch (_) {
      throw locationError('location_permission_denied', 'The remote service cannot read and write this folder. Choose another location.');
    }
    return resolved;
  }

  createFolder(locationId, name) {
    if (typeof name !== 'string' || !name || name.length > 255
      || /[\\/\u0000-\u001f<>:"|?*]/.test(name) || /^\.{1,2}$/.test(name) || /[. ]$/.test(name)) {
      throw locationError('location_invalid', 'Enter one folder name without slashes.');
    }
    const parent = this.writable(locationId);
    const destination = path.join(parent, name);
    // Non-recursive and exclusive: never reuse or overwrite an existing folder.
    fs.mkdirSync(destination, { mode: 0o700 });
    if (this.resolve(locationId) !== parent || fs.lstatSync(destination).isSymbolicLink()) {
      throw locationError('location_expired', 'The folder changed. Browse again.');
    }
    return this.remember(destination);
  }

  list({ locationId, folderPath, includePath = false, offset = 0 } = {}, roots = []) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new Error('Invalid folder page');
    if (folderPath !== undefined) {
      if (locationId || typeof folderPath !== 'string' || !path.isAbsolute(folderPath)
        || folderPath.length > 4096 || /[\u0000-\u001f]/.test(folderPath)) {
        throw locationError('location_invalid', 'Enter an absolute path on the selected computer.');
      }
      locationId = this.remember(folderPath).locationId;
    }
    const shortcuts = [os.homedir(), ...roots];
    if (process.platform === 'win32') {
      for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (fs.existsSync(`${letter}:\\`)) shortcuts.push(`${letter}:\\`);
    } else shortcuts.push('/');
    const locations = [...new Set(shortcuts)].flatMap((candidate) => {
      try { return [this.remember(candidate)]; } catch (_) { return []; }
    });
    const current = locationId ? this.resolve(locationId) : this.resolve(locations[0]?.locationId);
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) {
      throw locationError('location_permission_denied', 'The remote service cannot read this folder. Choose another location.');
    }
    const folders = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
    const directories = folders.slice(offset, offset + 200).flatMap((entry) => {
      try { return [this.remember(path.join(current, entry.name))]; } catch (_) { return []; }
    });
    const parent = path.dirname(current);
    let writable = true;
    try { this.writable(this.remember(current).locationId); } catch (_) { writable = false; }
    return {
      ...this.remember(current),
      ...(includePath ? { folderPath: current, writable } : {}),
      parentLocationId: parent === current ? null : this.remember(parent).locationId,
      locations,
      directories,
      nextOffset: offset + 200 < folders.length ? offset + 200 : null,
    };
  }
}

module.exports = { RemoteProjectLocations };
