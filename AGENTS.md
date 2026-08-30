# CAS Cloud development

CAS Cloud is the headless CodeAgentSwarm runtime. It has no GUI; clients reach
the main runtime through the encrypted relay, which opens no inbound port. The
optional `cas-preview` daemon is a separate loopback-only development service
that an operator may place behind their own TLS reverse proxy.

## Commands

- `npm install`
- `npm run build`
- `npm test`
- `node dist/cas.js doctor`

## Boundaries

- Keep Desktop, Electron UI, mobile UI and product-internal assets out of this repository.
- Keep the production dependency tree free of `electron`, `electron-builder` and `node-pty`.
- Use the relay protocol as the client boundary. Do not import a client application.
- Preserve parity for Claude, Codex, Antigravity, OpenCode, Kimi, Grok and Cursor.
- Keep credentials in environment variables or the local mode-`0600` configuration file.
- Keep the exported runtime free of operator-specific domains, filesystem layouts,
  service names, secrets and deployment files. The current product uses the hosted
  CodeAgentSwarm control plane and relay; independent self-hosting is not supported.
- CAS Cloud is moving toward an open-source distribution model. Do not describe the
  current PolyForm license as open source, but avoid coupling that would block a
  deliberate license transition later.
- Run the package tests before changing the exported source snapshot.
