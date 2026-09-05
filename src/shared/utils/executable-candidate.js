const fs = require('fs');

const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.cmd', '.bat'];

function candidateVariants(candidate, platform = process.platform) {
  const value = String(candidate || '').trim();
  if (!value) return [];
  if (platform !== 'win32' || /\.(exe|cmd|bat)$/i.test(value)) return [value];
  return WINDOWS_EXECUTABLE_EXTENSIONS.map((extension) => `${value}${extension}`);
}

function isRunnableExecutableCandidate(candidate, {
  fsImpl = fs,
  platform = process.platform,
} = {}) {
  const value = String(candidate || '').trim();
  if (!value) return false;
  if (platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(value)) return false;
  try {
    const stats = fsImpl.statSync(value);
    if (!stats.isFile() || stats.size <= 0) return false;
    if (platform !== 'win32') fsImpl.accessSync(value, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function findRunnableExecutableCandidate(candidates, options = {}) {
  const platform = options.platform || process.platform;
  for (const candidate of candidates || []) {
    for (const variant of candidateVariants(candidate, platform)) {
      if (isRunnableExecutableCandidate(variant, { ...options, platform })) return variant;
    }
  }
  return null;
}

module.exports = {
  candidateVariants,
  findRunnableExecutableCandidate,
  isRunnableExecutableCandidate,
};
