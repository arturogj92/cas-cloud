const os = require('os');
const path = require('path');

const TITLE_WORKDIR_PREFIX = 'codeagentswarm-title-';

function isConversationTitleWorkDir(workDir) {
  const resolved = path.resolve(String(workDir || ''));
  return path.dirname(resolved) === path.resolve(os.tmpdir())
    && path.basename(resolved).startsWith(TITLE_WORKDIR_PREFIX);
}

module.exports = { TITLE_WORKDIR_PREFIX, isConversationTitleWorkDir };
