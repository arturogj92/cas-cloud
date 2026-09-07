#!/usr/bin/env node

const { meetsVersion } = require('./infrastructure/services/node-runtime');

if (!meetsVersion(process.versions.node, '22.19.0')) {
  console.error(`CAS Cloud requires Node.js 22.19.0 or newer; found ${process.version}.`);
  process.exitCode = 1;
} else {
  const { main } = require('./cli/cas');
  Promise.resolve(main()).catch((error) => {
    console.error(`CAS CLI: ${error.message}`);
    process.exitCode = 1;
  });
}
