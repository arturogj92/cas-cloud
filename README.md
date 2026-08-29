# CAS Cloud CLI

Run CAS Cloud on a macOS or Ubuntu host and connect through the encrypted CodeAgentSwarm relay. The host opens no inbound port and exposes only the projects passed to `serve`.

## Install

Node.js 20 or newer is required.

```sh
npm install --global codeagentswarm
cas-cli --version
cas-cli doctor
cas-cli serve \
  --project /absolute/path/to/project-a \
  --project /absolute/path/to/project-b \
  --projects-root /absolute/path/to/clones
```

`npx codeagentswarm cloud ...` works without a global install. `serve` is the
equivalent command for an installed `cas-cli`. Before opening
the relay, `serve` checks and installs the seven supported agent CLIs and the
bundled CodeAgentSwarm MCP. Run `cas-cli setup` to perform that same setup explicitly.

The source is available under the PolyForm Noncommercial License 1.0.0. Commercial
use requires a separate license from CodeAgentSwarm.

`cas-cli` is the collision-safe executable name. The shorter `cas` alias is also installed.

Mobile and Desktop show all seven provider CLIs. On CAS Cloud, Mobile exposes
provider status and one **Sign in** button; the host launches the provider's
official login and keeps its credentials locally. Codex uses device
authentication so no callback port is required on the VPS. Provider accounts
are separate from the CAS account. On Linux, set `CAS_ACCESS_TOKEN`; optionally set
`CAS_REFRESH_TOKEN` so an expired access token can be renewed. `CAS_CLI_CONFIG`
overrides the identity file. Otherwise Linux stores it under
`$XDG_CONFIG_HOME/codeagentswarm` when `XDG_CONFIG_HOME` is absolute, or
`~/.config/codeagentswarm`.

CAS Cloud supports Claude, Codex, Antigravity, OpenCode, Kimi, Grok, and Cursor through the shared CodeAgentSwarm driver layer.
It publishes the same account-usage quotas as Desktop, and Mobile Settings can add,
edit or remove the project shortcuts stored by this CAS Cloud runtime.

## Linux user service

`systemd/cas-cli.service.example` is a user-service template. Copy it to
`~/.config/systemd/user/cas-cli.service`, replace the project paths and make
sure its `PATH` can find the global `cas-cli` executable. Keep credentials in
`~/.config/codeagentswarm/cas-cli.env` with mode `0600`; use
`CAS_ACCESS_TOKEN` and, when available, `CAS_REFRESH_TOKEN` there. Do not put
tokens in `ExecStart` or shell history.

```sh
mkdir -p ~/.config/systemd/user ~/.config/codeagentswarm
cp "$(npm root -g)/codeagentswarm/systemd/cas-cli.service.example" ~/.config/systemd/user/cas-cli.service
touch ~/.config/codeagentswarm/cas-cli.env
chmod 600 ~/.config/codeagentswarm/cas-cli.env
systemctl --user daemon-reload
systemctl --user enable --now cas-cli
systemctl --user status cas-cli
systemctl --user disable --now cas-cli
rm ~/.config/systemd/user/cas-cli.service
systemctl --user daemon-reload
```

Use `loginctl enable-linger "$USER"` only when the runtime must remain online
after logout. The service cannot accept a first-time pairing confirmation
without a terminal; run `cas-cli serve` interactively once to pair, then enable
the service. The runtime has no inbound listener.

## Smoke check

On Ubuntu or macOS, run the installed `cas-cli` binary's local checks without
starting a relay connection or writing CLI state:

```sh
"$(npm root -g)/codeagentswarm/scripts/cas-cli-smoke.sh"
```

Set `CAS_CLI_BIN` when the binary is not on `PATH`, or `CAS_CLI_PACKAGE_DIR`
for a non-global installation. The script checks Node 20+, `doctor`, and an
in-memory `better-sqlite3` database. It does not verify provider login or relay
credentials.
