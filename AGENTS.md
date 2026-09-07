# CAS Cloud development

CAS Cloud includes the headless runtime, browser client, independent control
plane and Cloudflare relay. Clients reach the main runtime through the encrypted
relay; the host opens no public inbound port. The
optional `cas-preview` daemon is a separate loopback-only development service
that an operator may place behind their own TLS reverse proxy.

## Commands

Use Node.js 22.19.0 or newer with npm on macOS or Linux.

- `npm install`
- `npm run build`
- `npm test`
- `node dist/cas.js doctor`

## Source and releases

- The canonical implementation is exported from the private CodeAgentSwarm source;
  do not hand-edit generated runtime files in this repository and then leave the
  private source behind.
- Keep `.cas-cloud-export.json` committed. It records the private source commit and
  exact generated file set used for this public snapshot.
- Before publishing, confirm the version is newer than the npm `latest` tag, run
  `npm install`, `npm run build`, `npm test`, `npx --yes . --version` and
  `node dist/cas.js doctor`, then inspect the packed file list.
- Push and npm publication are release actions. Obtain explicit authorization
  immediately before them, tag the published commit, and verify the registry tag.
- Deploy managed hosts through `cas-cli update`; never replace the `current` symlink
  by hand. The updater owns the idle-session guard, health check and rollback.

## Boundaries

- Keep Desktop, Electron UI, native mobile packaging and unrelated private assets out of this repository.
- Keep the production dependency tree free of `electron`, `electron-builder` and `node-pty`.
- Use the relay protocol as the client boundary. Keep the browser client in `web/` separate from host dependencies.
- Preserve parity for Claude, Codex, Antigravity, OpenCode, Kimi, Grok, Cursor and Pi.
- Keep credentials in environment variables or the local mode-`0600` configuration file.
- Keep the export free of operator-specific domains, service names, account IDs and
  secrets. Generic deployment templates belong in `self-hosting/`; installations
  supply their own web/API/relay origins and credentials as documented there.
- Validate `control-plane`, `relay` and `web` independently when their export changes.
- CAS Cloud uses AGPL-3.0-only, with third-party notices preserved. Desktop keeps
  its separate proprietary license. Prior published versions retain the license
  shipped with them; a new source snapshot does not retroactively relicense them.
- Run the package tests before changing the exported source snapshot.
