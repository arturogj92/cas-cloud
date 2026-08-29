#!/usr/bin/env node

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);

if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
  console.error(`CodeAgentSwarm requires Node.js 20 or newer; found ${process.version}.`);
  process.exitCode = 1;
} else {
  const { main } = require('./cli/cas');
  Promise.resolve(main()).catch((error) => {
    console.error(`CAS CLI: ${error.message}`);
    process.exitCode = 1;
  });
}
