const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const STORE_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function validIdentity(value) {
  return value
    && UUID_PATTERN.test(value.id)
    && typeof value.name === 'string'
    && value.name.length > 0
    && value.name.length <= 100;
}

function validConnection(value) {
  return value
    && typeof value.runtimeId === 'string'
    && value.runtimeId.length > 0
    && value.runtimeId.length <= 128
    && typeof value.relayOrigin === 'string'
    && typeof value.backendOrigin === 'string'
    && typeof value.deviceToken === 'string'
    && value.deviceToken.length > 0
    && value.deviceToken.length <= 8192
    && KEY_PATTERN.test(value.refreshToken)
    && Number.isSafeInteger(value.accessExpiresAt)
    && KEY_PATTERN.test(value.publicKey)
    && KEY_PATTERN.test(value.secretKey)
    && KEY_PATTERN.test(value.runtimePublicKey);
}

function normalize(raw) {
  if (!raw || raw.version !== STORE_VERSION || !validIdentity(raw.device)) {
    throw new Error('Remote runtime store is invalid');
  }
  if (raw.connection !== null && !validConnection(raw.connection)) {
    throw new Error('Remote runtime store is invalid');
  }
  return {
    version: STORE_VERSION,
    device: { ...raw.device },
    connection: raw.connection ? { ...raw.connection } : null,
  };
}

class RemoteRuntimeStore {
  constructor({ filePath, randomUUID = crypto.randomUUID } = {}) {
    if (!path.isAbsolute(filePath || '')) throw new Error('Remote runtime store path must be absolute');
    this.filePath = filePath;
    this.randomUUID = randomUUID;
    this.value = null;
    this.pending = Promise.resolve();
  }

  async loadOrCreate(deviceName = 'CodeAgentSwarm Desktop') {
    return this._serialize(async () => {
      const existing = await this._read();
      if (existing) return clone(existing);
      const created = {
        version: STORE_VERSION,
        device: { id: this.randomUUID(), name: String(deviceName).trim().slice(0, 100) },
        connection: null,
      };
      if (!validIdentity(created.device)) throw new Error('Remote runtime device identity is invalid');
      await this._write(created);
      return clone(created);
    });
  }

  async get() {
    if (this.value) return clone(this.value);
    const value = await this._read();
    return value ? clone(value) : null;
  }

  setConnection(connection) {
    return this._mutate((value) => ({ ...value, connection: clone(connection) }));
  }

  clearConnection(expectedRefreshToken) {
    return this._mutate((value) => {
      if (expectedRefreshToken && value.connection?.refreshToken !== expectedRefreshToken) return value;
      return { ...value, connection: null };
    });
  }

  _mutate(change) {
    return this._serialize(async () => {
      const current = this.value || await this._read();
      if (!current) throw new Error('Remote runtime store has not been initialized');
      const next = normalize(change(clone(current)));
      if (JSON.stringify(next) !== JSON.stringify(current)) await this._write(next);
      return clone(next);
    });
  }

  _serialize(action) {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }

  async _read() {
    if (this.value) return this.value;
    let raw;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('Remote runtime store could not be read');
    }
    try {
      this.value = normalize(JSON.parse(raw));
      return this.value;
    } catch {
      throw new Error('Remote runtime store is invalid');
    }
  }

  async _write(value) {
    const directory = path.dirname(this.filePath);
    const temporary = path.join(directory, `.${path.basename(this.filePath)}.${process.pid}.${this.randomUUID()}.tmp`);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw new Error('Remote runtime store could not be written');
    }
    this.value = normalize(value);
  }
}

module.exports = { RemoteRuntimeStore };
