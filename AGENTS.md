# CAS Cloud development

CAS Cloud is the headless CodeAgentSwarm runtime. It has no GUI and opens no
inbound port; clients reach it through the encrypted relay.

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
- Run the package tests before changing the exported source snapshot.
