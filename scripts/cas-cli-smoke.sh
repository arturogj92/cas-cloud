#!/usr/bin/env sh
set -eu

cas_cli_bin=${CAS_CLI_BIN:-cas-cli}
package_dir=${CAS_CLI_PACKAGE_DIR:-}

node_major=$(node -p "process.versions.node.split('.')[0]")
if [ "$node_major" -lt 20 ]; then
  echo "Node.js 20 or newer is required; found $(node --version)." >&2
  exit 1
fi

command -v "$cas_cli_bin" >/dev/null
"$cas_cli_bin" doctor

if [ -z "$package_dir" ]; then
  package_dir="$(npm root -g)/codeagentswarm"
fi

CAS_CLI_PACKAGE_DIR="$package_dir" node <<'NODE'
const path = require('path');
const packageDir = process.env.CAS_CLI_PACKAGE_DIR;
const Database = require(require.resolve('better-sqlite3', { paths: [packageDir] }));
const database = new Database(':memory:');
database.exec('CREATE TABLE smoke(value INTEGER); INSERT INTO smoke VALUES (1)');
if (database.prepare('SELECT value FROM smoke').get().value !== 1) process.exit(1);
database.close();
NODE

echo 'CAS CLI local smoke check passed.'
