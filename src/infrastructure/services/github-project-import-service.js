'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { findRunnableExecutableCandidate } = require('../../shared/utils/executable-candidate');

const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+$/;

class GitHubProjectImportService {
  constructor({
    execFileImpl = execFile,
    fsImpl = fs,
    osImpl = os,
    pathImpl = path,
    resolveEnv = async () => ({}),
    resolveExecutable = null,
  } = {}) {
    this.execFile = execFileImpl;
    this.fs = fsImpl;
    this.os = osImpl;
    this.path = pathImpl;
    this.resolveEnv = resolveEnv;
    this.resolveExecutable = resolveExecutable;
    this.executablePath = null;
  }

  async _env() {
    const resolved = await this.resolveEnv();
    const env = { ...process.env };
    for (const [key, value] of Object.entries(resolved || {})) {
      for (const existingKey of Object.keys(env)) {
        if (existingKey !== key && existingKey.toUpperCase() === key.toUpperCase()) delete env[existingKey];
      }
      env[key] = value;
    }
    return env;
  }

  async _findExecutable(env) {
    if (this.executablePath) return this.executablePath;
    if (this.resolveExecutable) {
      this.executablePath = await this.resolveExecutable(env);
      return this.executablePath;
    }

    const pathValue = env.PATH || env.Path || '';
    const candidates = pathValue
      .split(this.path.delimiter)
      .filter(Boolean)
      .map((directory) => this.path.join(directory, 'gh'));
    if (process.platform === 'win32') {
      candidates.push('C:\\Program Files\\GitHub CLI\\gh.exe');
    }
    this.executablePath = findRunnableExecutableCandidate(candidates);
    return this.executablePath;
  }

  async _run(args, { timeout = 30_000, maxBuffer = 20 * 1024 * 1024 } = {}) {
    const env = await this._env();
    const executable = await this._findExecutable(env);
    if (!executable) {
      const error = new Error('GitHub CLI is not installed');
      error.code = 'github_cli_missing';
      throw error;
    }

    return new Promise((resolve, reject) => {
      this.execFile(executable, args, { env, timeout, maxBuffer, windowsHide: true }, (error, stdout = '', stderr = '') => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  _defaultBaseDirectory() {
    const home = this.os.homedir();
    for (const candidate of [this.path.join(home, 'Development'), this.path.join(home, 'Developer'), home]) {
      try {
        if (this.fs.statSync(candidate).isDirectory()) return candidate;
      } catch (_) { /* try the next conventional directory */ }
    }
    return home;
  }

  _message(error) {
    return String(error?.stderr || error?.message || 'GitHub request failed')
      .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
  }

  async getStatus() {
    const env = await this._env();
    const executable = await this._findExecutable(env);
    const base = { defaultBaseDirectory: this._defaultBaseDirectory() };
    if (!executable) return { success: true, installed: false, authenticated: false, ...base };

    try {
      const { stdout } = await this._run(['api', 'user']);
      const user = JSON.parse(stdout);
      return {
        success: true,
        installed: true,
        authenticated: true,
        account: {
          login: user.login,
          name: user.name || user.login,
          avatarUrl: user.avatar_url || null,
        },
        ...base,
      };
    } catch (error) {
      return { success: true, installed: true, authenticated: false, error: this._message(error), ...base };
    }
  }

  async listRepositories() {
    try {
      const { stdout } = await this._run([
        'api',
        '--paginate',
        '--slurp',
        'user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member',
      ]);
      const parsed = JSON.parse(stdout);
      const repositories = (Array.isArray(parsed[0]) ? parsed.flat() : parsed)
        .filter((repo) => repo && repo.full_name && repo.name)
        .map((repo) => ({
          id: repo.id,
          name: repo.name,
          fullName: repo.full_name,
          description: repo.description || '',
          isPrivate: Boolean(repo.private),
          isFork: Boolean(repo.fork),
          updatedAt: repo.updated_at || null,
          language: repo.language || null,
          owner: repo.owner?.login || repo.full_name.split('/')[0],
          url: repo.html_url || `https://github.com/${repo.full_name}`,
        }));
      return { success: true, repositories };
    } catch (error) {
      return { success: false, error: this._message(error), code: error.code || 'github_request_failed' };
    }
  }

  async connect() {
    try {
      await this._run(
        ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'],
        { timeout: 10 * 60_000, maxBuffer: 1024 * 1024 },
      );
      return this.getStatus();
    } catch (error) {
      return { success: false, error: this._message(error), code: error.code || 'github_auth_failed' };
    }
  }

  async remoteRepositories() {
    const status = await this.getStatus();
    const result = { success: true, installed: status.installed, authenticated: status.authenticated };
    if (!status.authenticated) return result;
    const listed = await this.listRepositories();
    if (!listed.success) return { success: false, error: 'Could not load repositories from GitHub on the remote computer.' };
    return {
      ...result,
      account: { login: String(status.account?.login || '').slice(0, 100) },
      repositories: listed.repositories.filter((repo) => typeof repo.fullName === 'string' && repo.fullName.length <= 240 && REPOSITORY_PATTERN.test(repo.fullName)).slice(0, 500).map((repo) => ({
        name: repo.fullName.split('/')[1],
        fullName: repo.fullName,
        owner: repo.fullName.split('/')[0],
        description: String(repo.description || '').slice(0, 300),
        language: String(repo.language || '').slice(0, 80),
        isPrivate: repo.isPrivate === true,
      })),
      truncated: listed.repositories.length > 500,
    };
  }

  async prepareRemoteClone(payload) {
    if (payload.githubRepository === undefined) return payload;
    const repository = payload.githubRepository;
    if (typeof repository !== 'string' || repository.length > 240 || !REPOSITORY_PATTERN.test(repository)
      || payload.url !== `https://github.com/${repository}.git`) {
      throw Object.assign(new Error('Choose a valid GitHub repository'), { code: 'invalid_git_url' });
    }
    const executable = await this._findExecutable(await this._env());
    if (!executable) throw Object.assign(new Error('GitHub CLI is not installed on this computer'), { code: 'github_cli_missing' });
    // Git uses sh for credential helpers on Windows too. Quote the executable, never a token.
    const quoted = `'${executable.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
    return {
      ...payload,
      gitConfig: ['-c', 'credential.helper=', '-c', `credential.https://github.com.helper=!${quoted} auth git-credential`],
    };
  }

  async cloneRepository({ repository, baseDirectory }) {
    const fullName = String(repository || '').trim();
    const rawBase = String(baseDirectory || '').trim();
    if (!REPOSITORY_PATTERN.test(fullName)) {
      return { success: false, code: 'invalid_repository', error: 'Invalid GitHub repository' };
    }
    if (!rawBase || !this.path.isAbsolute(rawBase)) {
      return { success: false, code: 'invalid_destination', error: 'Choose an absolute destination directory' };
    }
    const base = this.path.resolve(rawBase);

    try {
      const stats = await this.fs.promises.stat(base);
      if (!stats.isDirectory()) throw new Error('Destination is not a directory');
      await this.fs.promises.access(base, this.fs.constants.W_OK);
    } catch (error) {
      return { success: false, code: 'invalid_destination', error: this._message(error) };
    }

    const name = fullName.split('/')[1];
    const destination = this.path.resolve(base, name);
    if (this.path.dirname(destination) !== base) {
      return { success: false, code: 'invalid_destination', error: 'Invalid destination directory' };
    }
    if (this.fs.existsSync(destination)) {
      return { success: false, code: 'destination_exists', error: 'The destination folder already exists', path: destination };
    }

    try {
      await this._run(['repo', 'clone', fullName, destination], { timeout: 30 * 60_000 });
      const stats = await this.fs.promises.stat(destination);
      if (!stats.isDirectory()) throw new Error('GitHub CLI did not create the repository directory');
      return { success: true, path: destination, repository: fullName };
    } catch (error) {
      return { success: false, code: error.code || 'clone_failed', error: this._message(error) };
    }
  }
}

module.exports = { GitHubProjectImportService, REPOSITORY_PATTERN };
