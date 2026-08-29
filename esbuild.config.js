const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');
const esbuild = require('esbuild');
const packageJson = require('./package.json');

const packageDirectory = __dirname;
const outputDirectory = path.join(packageDirectory, 'dist');
const runtimeDependencies = new Set(Object.keys(packageJson.dependencies));
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

function packageRoot(specifier) {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
}

const strictRuntimeBoundary = {
  name: 'strict-cas-cli-runtime-boundary',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === 'entry-point' || args.path.startsWith('.') || path.isAbsolute(args.path)) {
        return null;
      }
      if (builtins.has(args.path)) return { path: args.path, external: true };
      if (args.path === 'electron') return { path: 'electron', namespace: 'cas-cli-headless' };
      if (runtimeDependencies.has(packageRoot(args.path))) {
        return { path: args.path, external: true };
      }
      return {
        errors: [{ text: `Undeclared CAS CLI runtime dependency: ${args.path}` }],
      };
    });

    build.onLoad({ filter: /^electron$/, namespace: 'cas-cli-headless' }, () => ({
      contents: `module.exports = {
        shell: {
          openPath: async () => 'Opening local references is unavailable in the headless runtime.'
        }
      };`,
      loader: 'js',
    }));
  },
};

async function build() {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const result = await esbuild.build({
    entryPoints: {
      cas: path.join(packageDirectory, 'src', 'entry.js'),
      'mcp-stdio-server': path.join(packageDirectory, 'src', 'infrastructure', 'mcp', 'mcp-stdio-server.js'),
      'antigravity-mcp-launcher': path.join(packageDirectory, 'src', 'infrastructure', 'mcp', 'antigravity-mcp-launcher.js'),
    },
    outdir: outputDirectory,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node16',
    legalComments: 'none',
    metafile: true,
    define: {
      CAS_CLI_BUNDLED_VERSION: JSON.stringify(packageJson.version),
    },
    plugins: [strictRuntimeBoundary],
  });

  const externalImports = new Set();
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports || []) {
      if (imported.external && !builtins.has(imported.path)) {
        externalImports.add(packageRoot(imported.path));
      }
    }
  }
  for (const dependency of externalImports) {
    if (!runtimeDependencies.has(dependency)) {
      throw new Error(`Bundle contains undeclared runtime dependency: ${dependency}`);
    }
  }

  for (const outputFile of Object.keys(result.metafile.outputs)) {
    if (!outputFile.endsWith('.js')) continue;
    const bundle = fs.readFileSync(path.resolve(outputFile), 'utf8');
    for (const forbidden of ['require("electron")', 'electron-builder', 'node-pty']) {
      if (bundle.includes(forbidden)) throw new Error(`Bundle contains forbidden dependency: ${forbidden}`);
    }
    fs.chmodSync(path.resolve(outputFile), 0o755);
  }
  return result;
}

if (require.main === module) {
  build().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { build };
