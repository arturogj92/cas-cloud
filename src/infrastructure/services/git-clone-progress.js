'use strict';

// Never forward raw Git output: it can contain credentials and private paths.
function cloneProgress(text) {
  const matches = [...String(text).matchAll(/(Receiving objects|Resolving deltas|Updating files|Checking out files):\s+(\d{1,3})%/g)];
  const match = matches.at(-1);
  return match && Number(match[2]) <= 100 ? { phase: match[1], progress: Number(match[2]) } : null;
}

module.exports = { cloneProgress };
