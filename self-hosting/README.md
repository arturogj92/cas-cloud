# Run your own CAS Cloud

You can use CAS Cloud with CodeAgentSwarm Desktop through the CodeAgentSwarm
relay, without deploying the web client, API or relay yourself. See the
[Desktop connection instructions](../README.md#install).

This guide covers the other option: running your own web client, API and relay
and using CAS Cloud from your browser without Desktop. The source repository
includes the agent host, the browser client used by `web.codeagentswarm.com`, an
independent control plane and the Cloudflare relay. Your deployment uses your
own credentials and infrastructure; no CodeAgentSwarm account, Railway project
or Supabase project is required. Desktop can also connect to this deployment
through the same pairing protocol.

| Directory | Runs where | Responsibility |
| --- | --- | --- |
| Repository root | Your Mac or Linux machine/VPS | Agent execution, projects, conversations and provider credentials |
| `web/` | Local development server or any static web host | Browser client |
| `control-plane/` | Local machine or VPS | Host authentication, signed relay tickets, paired devices and refresh credentials in SQLite |
| `relay/` | Local Wrangler or your Cloudflare account | Encrypted WebSockets, pairing, previews, Durable Object routing and D1 quota guard |

Each installation is one trust group. Hosts with its `CAS_ACCESS_TOKEN` can pair
clients and join that installation's host network. Give unrelated users separate
installations. There is no signup, billing service or multi-tenant account system.
Agent provider accounts and charges remain yours.

## Requirements

The host, API, web client and relay can run in different places. They do not
require a particular VPS provider or an existing Caddy installation.

| Component | What it needs |
| --- | --- |
| Agent host | macOS or Linux, Node.js 22.19.0 or newer, npm, Git, your projects and provider sign-in. The host must stay running while you use it. |
| API | Node.js and a persistent writable directory for its SQLite database. The supplied container includes Node; no separate database server is needed. |
| Web client | Static hosting for the compiled `web/dist` files. Node is needed to build it, but not to serve the compiled files or use them in a browser. |
| Relay | Your Cloudflare account with Workers, Durable Objects and D1 for a public deployment. Local testing uses Wrangler without a Cloudflare account. |
| Remote access | HTTPS addresses reachable by the browser and host. Plain HTTP works only on loopback for same-machine testing. |

**Docker and Caddy are deployment choices.** The quick setup uses Docker Compose
and includes Caddy in the web container to serve files and configure HTTPS. You
do not install Caddy separately. You can also run the services directly and use
Nginx, an existing Caddy server or managed HTTPS hosting. If ports 80/443 already
belong to your web server, use the manual deployment instructions instead of
starting another server on those ports.

The supplied Compose files include Node for the API and web build. They run the
agent host separately, so Node must also be available wherever that host runs.
The setup script itself requires Node. Building the web client on your workstation
and uploading `web/dist` avoids installing build tools on a static web server.

### Credentials you provide

- **Cloudflare access:** Wrangler login or your own API token/account ID, only
  for deploying your relay. A `workers.dev` address works; a custom relay domain
  is optional in the manual setup. The automated VPS setup uses a domain in
  your Cloudflare account.
- **Host and relay secrets:** the quick setup generates them. For manual setup,
  generate the two secrets described below; neither is a provider API key.
- **Provider account:** sign in to Codex or another provider on the agent host,
  as the same operating-system user that runs CAS Cloud. Installing a CLI does
  not sign in to its account. Do not put provider credentials in the web build.

For Codex, after the host has installed the provider CLI, open another terminal
as that host user and run:

```sh
codex login --device-auth
codex login status
```

Open the verification URL and enter the code shown by Codex. An existing login
in that user's profile can be reused; you do not need to copy credentials from
another machine. If you run the host as a service, preserve its user profile and
provider credentials across restarts.

## Quick setup

Install Node.js 22.19.0 or newer, Git and Docker with Compose. Clone the source
repository and run one command:

```sh
git clone https://github.com/arturogj92/cas-cloud.git
cd cas-cloud
node self-hosting/setup.js --local
```

The setup generates two independent secrets, configures all services and starts
web, API and a local Cloudflare runtime in Docker. Open `http://localhost:8081`.
No Cloudflare account or API key is needed locally. Start the host on the machine
where your projects and provider accounts live:

```sh
npm ci && npm run build
node --env-file=self-hosting/host.env dist/cas.js serve --project /path/to/project
```

Enter the host's pairing code in the web client. The host environment file
contains only the host credential and public origins, never the relay signing
secret. Setup saves credential files with owner-only permissions and preserves
the generated secrets when rerun.

For a VPS with a domain managed in your Cloudflare account:

```sh
node self-hosting/setup.js --vps
```

Enter your base domain, for example `example.com`, and authenticate through
Wrangler's Cloudflare login. If you already use API credentials, supply
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the process environment;
setup does not save them. The token needs permission to deploy Workers, manage
D1 and configure the Worker's custom domain in that account/zone.

The VPS setup creates the D1 binding, applies migrations, configures the relay
secret and deploys `relay.example.com`, then builds the web/API containers.
Point `web.example.com` and `api.example.com` at your VPS and allow ports 80/443.
Caddy provisions HTTPS. The generated host command is the same as for local use.
These steps create resources in your own account; Cloudflare/provider charges
are yours. For custom subdomains or an existing relay, use the manual steps.

To stop the local services without deleting data:

```sh
cd self-hosting
docker compose -f compose.local.yaml down
```

Use `docker compose down` for the VPS services. Do not add `-v` unless you intend
to delete the device database and local relay state.

## Manual local installation

Use Node.js 22.19.0 or newer, npm, Git and a C++ build toolchain if a native SQLite
binary is unavailable. Run these commands from a clone of the **public CAS Cloud source
repository**, not the installed npm tarball. The npm package contains the host;
the source repository also contains the services and web client.

```sh
git clone https://github.com/arturogj92/cas-cloud.git
cd cas-cloud
npm ci
npm run build
npm ci --prefix control-plane
npm ci --prefix relay
npm ci --prefix web
cp control-plane/.env.example control-plane/.env
cp relay/.dev.vars.example relay/.dev.vars
cp web/.env.example web/.env.local
```

Generate **two different secrets**, running this command once for each:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Set `CAS_ACCESS_TOKEN` and `MOBILE_RELAY_SECRET` in `control-plane/.env`. Copy only
the **relay secret** into `relay/.dev.vars` as `MOBILE_RELAY_SECRET`. Keep the
other example values for this local setup. Do not put either secret in the web
environment: every `EXPO_PUBLIC_*` value is public browser code.

Start the following processes in separate terminals, from the repository root:

```sh
# Terminal 1: local Cloudflare services, no Cloudflare account needed.
cd relay
npx wrangler d1 migrations apply RELAY_QUOTA --local
npm run dev -- --ip 127.0.0.1 --port 8787
```

```sh
# Terminal 2: the independent API; npm start reads control-plane/.env.
cd control-plane
npm start
```

```sh
# Terminal 3: browser client; Expo reads web/.env.local.
cd web
npm run web -- --port 8081
```

```sh
# Terminal 4: host; replace the project path with an existing directory.
CAS_BACKEND_URL=http://127.0.0.1:8788 \
CAS_WEB_ORIGIN=http://localhost:8081 \
CAS_PAIRING_CODE_ORIGIN=http://127.0.0.1:8787 \
node --env-file=control-plane/.env dist/cas.js serve --project /path/to/project
```

Open `http://localhost:8081` on the same machine and enter the displayed pairing
code, or open the complete pairing URL printed by the host. The host installs
the supported agent CLIs and their MCP integration on first use. Sign in to
each provider you intend to use; the host token does not sign in to providers.

The loopback URLs only work on that machine. For a phone, another computer or a
public deployment, use HTTPS origins reachable by every participant. A LAN IP
over plain HTTP is deliberately rejected by the pairing protocol.

## Your Cloudflare relay

From `relay/`, authenticate to **your** Cloudflare account and provision the
database. No account ID, database ID or credentials from our deployment are
shipped in the public configuration.

```sh
npx wrangler login
npx wrangler d1 create cas-cloud-relay-quota
```

Replace the placeholder `database_id` in `relay/wrangler.jsonc` with the ID the
command returns. The `RUNTIMES` Durable Object binding and its SQLite migration
are already declared in that file. Keep the `RELAY_QUOTA` binding name.

```sh
npx wrangler d1 migrations apply RELAY_QUOTA --remote
npx wrangler secret put MOBILE_RELAY_SECRET
npm run deploy
```

Paste the same `MOBILE_RELAY_SECRET` configured in your control plane. Use the
deployed `https://cas-cloud-relay.<your-subdomain>.workers.dev` origin or attach
your own Worker custom domain, such as `relay.example.com`. Set this exact origin
in the API's `MOBILE_RELAY_URL`, the host's `CAS_PAIRING_CODE_ORIGIN` and the
web build's `EXPO_PUBLIC_MOBILE_RELAY_URL`.

The relay needs outbound HTTPS/WSS from clients; the agent host opens no public
inbound port. D1 stores quota reservations and Durable Objects manage relay and
pairing state. Messages use the existing end-to-end encryption. Keep the shipped
quota guard and hibernation behavior; inspect your Cloudflare account's current
limits and billing before increasing the thresholds.

## Web and API on a VPS with Docker Compose

Install Docker with Compose on the VPS. Point `web.example.com` and
`api.example.com` DNS records at it, allow inbound TCP 80/443, and provision the
Cloudflare relay using the instructions in this guide. The supplied Compose
file runs the web server and control plane; the agent host runs separately on
any supported Mac/Linux host, including this VPS.

In `control-plane/.env`, keep your two generated secrets and set:

```dotenv
MOBILE_RELAY_URL=https://relay.example.com
CAS_WEB_ORIGIN=https://web.example.com
```

Configure the public domains and relay URL for Compose:

```sh
cp self-hosting/.env.example self-hosting/.env
# Edit self-hosting/.env with your own domains and deployed relay origin.
cd self-hosting
docker compose up --build -d
```

Caddy serves the compiled web app and provisions TLS certificates for both
domains. The API is reachable through Caddy and is not separately exposed on a
public port. SQLite and Caddy state use persistent named volumes. The browser
relay origin is fixed **at build time**; rebuild the web image after changing it.

Start the agent host with the same `CAS_ACCESS_TOKEN` as the API:

```sh
CAS_ACCESS_TOKEN='<your-host-token>' \
CAS_BACKEND_URL=https://api.example.com \
CAS_WEB_ORIGIN=https://web.example.com \
CAS_PAIRING_CODE_ORIGIN=https://relay.example.com \
node dist/cas.js serve --project /path/to/project
```

For a persistent host, use the repository's `systemd/cas-cli.service.example` and
its environment file. Run as your own unprivileged service user; preserve its
state directory and provider credentials across updates. The same web build can
also be hosted on your own Cloudflare Pages project or another static host:
`npm run export:web --prefix web` produces `web/dist`. Configure SPA fallback to
`index.html` and use the chosen web origin in the API and host configuration.

### Using an existing web server, without Docker

Deploy your relay first. Configure `control-plane/.env` with the two secrets,
the relay's HTTPS origin and your web origin, as in the manual installation.
Then install and start the API from the source repository:

```sh
npm ci --prefix control-plane
cd control-plane
npm start
```

Keep its default loopback listener and route your API HTTPS address to
`127.0.0.1:8788` through your existing reverse proxy. Keep the API running with
your service manager, under its own unprivileged user and with persistent
storage for `CAS_CLOUD_DATABASE`.

From the repository root, build the web client with your deployed relay address
in `web/.env.local`:

```sh
npm ci --prefix web
npm run export:web --prefix web
```

Serve only `web/dist` at your web HTTPS address, with unmatched paths falling
back to `index.html`. Do not serve the source repository or environment files.
Your existing web server handles certificates; no additional Caddy installation
is needed. Finally, build and start the agent host using the host command in
the quick setup or VPS instructions, with your API, web and relay origins.

## Connect CodeAgentSwarm Desktop

You can also use Desktop as a client of your self-hosted CAS Cloud instance.
Configure it to use your relay, then pair it with your host.

Set `CAS_PAIRING_CODE_ORIGIN` to your relay origin **in Desktop's process
environment** before starting it. Then use Settings → Remote to enter the host's
code. `cas-cli connect` also prints a short connection link for this relay; the
Desktop receiving that link must use the same configured relay origin. The host
prints a complete pairing URL at startup, which carries its API and relay
origins. Do not give Desktop the host's administrative `CAS_ACCESS_TOKEN` or the
relay signing secret; the pairing flow gives it a revocable device credential.

An environment variable set in a terminal does not update an already-running
Desktop process. Start a fresh process with that environment. Without an override,
short codes resolve against the hosted relay and cannot find your private code.

## Operations and checks

To repeat the live browser-to-agent check after setup, install the web development
dependencies and Playwright's Chromium, then run:

```sh
npm ci --prefix web
cd web && npx playwright install chromium && cd ..
node self-hosting/verify.js
```

This check requires a signed-in Codex CLI and sends one real prompt using that
account. It starts a real exported host with a disposable project and private
state, pairs a headless browser by short code, opens the project, creates a
Codex session, checks its reply, reloads and reopens it, and captures desktop and
mobile screenshots. It uses your running web/API/relay and writes results under
`self-hosting/verification/`. It stops its own host and removes its temporary
project afterwards; it does not stop your services or other hosts.

- Check `GET /health` on your API and relay, then pair a browser and open a project.
- `npm test --prefix control-plane` checks host authentication, device tickets,
  persistent refresh rotation and revocation against the actual router and SQLite.
- `npm test --prefix relay` checks the Worker; `npm run check --prefix relay`
  compiles a dry-run deployment. For the local Compose stack, run
  `docker compose -f compose.local.yaml exec -T -e CAS_RELAY_URL=http://127.0.0.1:8787 relay node --env-file=.dev.vars --test test/relay.integration.test.js`
  from `self-hosting/`. This exercises real Durable Objects, pairing, encrypted
  routing, credential expiry/renewal and previews. Run it inside the relay container
  so its exact five-minute expiry assertions use the same clock as the Worker.
- `npm test --prefix web` and `npm run typecheck --prefix web` check the browser
  source. `npm run export:web --prefix web` proves it builds independently.
- Keep `CAS_ACCESS_TOKEN` on authorized hosts only. Rotating it invalidates host
  authentication but does not revoke existing devices. Remove devices through
  the authorized host's device controls; refresh is denied after revocation.
  Already-issued device access tokens expire within an hour; stop the relay or
  rotate its signing secret if you need to invalidate all credentials immediately.
- To rotate `MOBILE_RELAY_SECRET`, update both API and Worker, restart/redeploy
  them, and pair devices again. This also changes the host network identity.
- Back up the API SQLite database with SQLite's backup command, or stop the API
  before copying its database and WAL files. Back up each host's projects and CAS
  state separately. The API database contains no conversations or provider keys.
- Pull an updated source snapshot, run the tests, apply any new D1 migrations,
  deploy the relay, and rebuild the web/API containers. Preserve secrets and
  persistent volumes; `docker compose down -v` deletes that state.
- For host updates built from modified source, keep your own build/install process.
  The default managed updater installs the public npm package; enable it only if
  you want upstream host releases to replace your locally built host.
- Optional voice transcription uses your `GROQ_API_KEY`. Without it the API returns
  an unavailable response for transcription. Native push uses Expo when a native
  device registers a push token; browser pairing and chat do not require Expo
  credentials. Diagnostic events stay in your service logs, with no hosted CAS
  analytics database.

Keep `.env`, `.dev.vars`, SQLite files, provider credentials and deployment-specific
configuration out of public commits. The source license and third-party notices
are in the repository root; brand assets do not grant trademark rights.
