# CAS Cloud CLI

Run CAS Cloud on a macOS or Ubuntu host and connect through the encrypted CodeAgentSwarm relay. The host opens no inbound port and exposes only the projects passed to `serve`.

## Install

Node.js 20 or newer is required.

```sh
npm install --global @codeagentswarm/cas-cloud
cas-cli --version
cas-cli doctor
cas-cli serve \
  --project /absolute/path/to/project-a \
  --project /absolute/path/to/project-b \
  --projects-root /absolute/path/to/clones
```

`npx @codeagentswarm/cas-cloud serve ...` works without a global install. Before opening
the relay, `serve` checks and installs the seven supported agent CLIs and the
bundled CodeAgentSwarm MCP. It also installs the guarded global instructions
that publish each session's title, activity and work-phase status. Run
`cas-cli setup` to perform that same setup explicitly.

To let a Cloud session read or start work on your Mac, enable **Session
communication** on the Mac, create a Mobile Connect pairing code, and keep the
Cloud service running while you link it:

```sh
cas-cli link 7K9D-M2QF
cas-cli remote-status
cas-cli unlink
```

The Mac must approve the matching six-digit verification code. The link is
revocable and end-to-end encrypted through the existing relay. Cloud agents can
list eligible Mac sessions, read a bounded user/assistant transcript, or list an
opaque project and start one new Mac session with a prompt when you explicitly
ask. Only assistant prose returns; paths, reasoning and tool output do not.

Desktop's ordinary CAS Cloud pairing provides the reverse direction. With both
links approved, a Mac session can perform the same explicit read or remote start
on CAS Cloud. Direct message injection into an existing cross-host session stays
disabled.

Except for components identified in `THIRD_PARTY_NOTICES.md`, this is
source-available software under the PolyForm Noncommercial License 1.0.0, not
OSI-approved open source. Commercial use of Arturo Garcia's CAS Cloud code
requires a separate written license from Arturo Garcia. Contact
`hello@codeagentswarm.com` for commercial licensing.

CAS Cloud is not a separate rewrite of CodeAgentSwarm. This repository is a
generated, independently buildable release mirror of the shared headless runtime.
The canonical private source exports only that tested runtime boundary; Desktop,
Mobile, the control plane and deployment secrets are not included.

`cas-cli` is the collision-safe executable name. The `cas-cloud` alias lets npm
infer the executable for `npx @codeagentswarm/cas-cloud`; the shorter `cas` alias
is also installed.

## Ephemeral development previews

`cas-preview` is an optional, separate service for temporary browser previews. It
starts and owns each development command, exposes it through an unguessable path,
and terminates the whole process group after a hard two-hour TTL. It listens on
loopback plus a mode-`0600` Unix control socket by default; the main CAS Cloud
runtime still opens no inbound listener.

Install `systemd/cas-preview.service.example` as a system service, adjust
its project root and public origin, and put the matching
`caddy/Caddyfile.preview.example` site behind a domain you control. Then start a
temporary app with:

```sh
cas-preview start --cwd /srv/cas-projects/my-app --port 4173 -- \
  npm run dev -- --host 127.0.0.1 --port 4173
cas-preview list
cas-preview stop LEASE_ID
```

The service refuses to adopt a port that was already listening, so it never kills
an unrelated process. The generated URL is a bearer capability rather than login
authentication; do not use it for sensitive or production data.

The executable has no vendor-specific domain or filesystem root. `serve` accepts
`--public-origin`, `--root`, `--socket`, `--ttl-seconds`, `--listen`, and `--port`;
`CAS_PREVIEW_PUBLIC_ORIGIN`, `CAS_PREVIEW_ROOT`, and `CAS_PREVIEW_SOCKET` provide
deployment-level defaults. Without deployment configuration it stays local, uses
the current directory as its root, places the control socket in `XDG_RUNTIME_DIR`
or the OS temporary directory, and prints a loopback URL.

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

## Linux user service with automatic updates

The service uses a stable `current` symlink so an update can be installed beside
the running version, health-checked, and rolled back without overwriting it.
Bootstrap that managed installation once:

```sh
mkdir -p "$HOME/.local/share/codeagentswarm-cloud/releases/initial"
npm install --prefix "$HOME/.local/share/codeagentswarm-cloud/releases/initial" --omit=dev --no-audit --no-fund @codeagentswarm/cas-cloud@latest
ln -sfn "$HOME/.local/share/codeagentswarm-cloud/releases/initial" "$HOME/.local/share/codeagentswarm-cloud/current"
```

Copy the three templates to `~/.config/systemd/user`, remove the `.example`
suffixes, and replace the project paths in `cas-cli.service`. Keep credentials in
`~/.config/codeagentswarm/cas-cli.env` with mode `0600`; use
`CAS_ACCESS_TOKEN` and, when available, `CAS_REFRESH_TOKEN` there. Do not put
tokens in `ExecStart` or shell history. If Node came from nvm, edit the `PATH=`
line in both services to include that Node version's `bin` directory.

```sh
mkdir -p ~/.config/systemd/user ~/.config/codeagentswarm
cp "$HOME/.local/share/codeagentswarm-cloud/current/node_modules/@codeagentswarm/cas-cloud/systemd/cas-cli.service.example" ~/.config/systemd/user/cas-cli.service
cp "$HOME/.local/share/codeagentswarm-cloud/current/node_modules/@codeagentswarm/cas-cloud/systemd/cas-cli-update.service.example" ~/.config/systemd/user/cas-cli-update.service
cp "$HOME/.local/share/codeagentswarm-cloud/current/node_modules/@codeagentswarm/cas-cloud/systemd/cas-cli-update.timer.example" ~/.config/systemd/user/cas-cli-update.timer
touch ~/.config/codeagentswarm/cas-cli.env
touch ~/.config/codeagentswarm/cas-cli-update.env
chmod 600 ~/.config/codeagentswarm/cas-cli.env ~/.config/codeagentswarm/cas-cli-update.env
systemctl --user daemon-reload
systemctl --user enable --now cas-cli cas-cli-update.timer
systemctl --user status cas-cli
systemctl --user list-timers cas-cli-update.timer
systemctl --user kill --kill-whom=main --signal=SIGUSR1 cas-cli
systemctl --user disable --now cas-cli-update.timer cas-cli
rm ~/.config/systemd/user/cas-cli.service ~/.config/systemd/user/cas-cli-update.service ~/.config/systemd/user/cas-cli-update.timer
systemctl --user daemon-reload
```

The timer checks hourly. It defers while any agent is producing a response. Once
idle, it installs `@codeagentswarm/cas-cloud@latest` in a new release directory, switches
the symlink, restarts CAS Cloud, and waits up to twenty-five minutes for the new runtime
to report healthy. If that check fails, it restores the previous symlink and
restarts the old version. Set `CAS_CLI_UPDATE_SPEC` in
`~/.config/codeagentswarm/cas-cli-update.env` to use another npm tag, version,
or package tarball. The updater service does not load the runtime credential file,
and it strips secret-like variables before invoking npm. If the runtime sets
`XDG_CONFIG_HOME` or `CAS_CLI_STATE`, copy that same non-secret path setting into
`cas-cli-update.env` so both services read the same state file. Package staging
times out after ten minutes by default; systemd leaves the bounded health check
and rollback in control instead of killing the updater mid-switch.

### One-time migration from `codeagentswarm`

The updater bundled with legacy `codeagentswarm@2.4.0` cannot recognize a scoped
package. Leave the managed service and `current` symlink in place, then launch the
new updater once through `npx` from the same environment as the updater service:

```sh
CAS_CLI_INSTALL_ROOT="$HOME/.local/share/codeagentswarm-cloud" \
CAS_CLI_UPDATE_SPEC="@codeagentswarm/cas-cloud@2.4.1" \
npx --yes "@codeagentswarm/cas-cloud@2.4.1" update
```

Carry over any non-secret `CAS_CLI_STATE`, `CAS_CLI_SYSTEMD_SCOPE` and
`CAS_CLI_SERVICE` settings from `cas-cli-update.env`. This runs the new updater
against the legacy layout, so it still defers active sessions, health-checks the
scoped release and rolls back on failure. Do not switch the symlink by hand.

CAS Cloud writes only resumable, active session metadata to a mode-`0600` local
state file. A restart reopens those provider conversations and restores their
title, project, status, and minimized state with at most six provider handshakes
at once. No interrupted prompt is resent.
Providers without native resume support stay available in History instead.
The updater briefly rejects new prompts only after staging and before restart;
the client marks them failed so they can be retried instead of losing them.

Use `loginctl enable-linger "$USER"` only when the runtime must remain online
after logout. The one-time QR or eight-character code authorizes its own pairing,
so a headless service accepts it without waiting for terminal input. The runtime
has no inbound listener. `SIGUSR1` prints a fresh five-minute code without
stopping active sessions. A service restart now reopens every resumable active
session automatically.

## Smoke check

On Ubuntu or macOS, run the installed `cas-cli` binary's local checks without
starting a relay connection or writing CLI state:

```sh
"$(npm root -g)/@codeagentswarm/cas-cloud/scripts/cas-cli-smoke.sh"
```

Set `CAS_CLI_BIN` when the binary is not on `PATH`, or `CAS_CLI_PACKAGE_DIR`
for a non-global installation. The script checks Node 20+, `doctor`, and an
in-memory `better-sqlite3` database. It does not verify provider login or relay
credentials.
