const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// Expo SDK 54 can evaluate marshal before Android injects its initial props.
// Recheck the real bridge at use time; remove when Expo ships this fix.
function patch(source) {
  if (source.includes('const IS_DOM = () =>')) return source;
  assert.ok(source.includes('const IS_DOM =\n'), 'Expo DOM guard changed; review compatibility');
  assert.equal(source.match(/if \(!IS_DOM\)/g)?.length, 3, 'Expo DOM guard callers changed');
  return source.replace('const IS_DOM =\n', 'const IS_DOM = () =>\n').replaceAll('if (!IS_DOM)', 'if (!IS_DOM())');
}

function patchSizeObserver(source) {
  if (source.includes("document.readyState === 'loading'")) return source;
  assert.ok(source.includes("window.addEventListener('DOMContentLoaded', () => {"), 'Expo DOM size observer changed; review compatibility');
  assert.ok(source.includes('  });\n  })();'), 'Expo DOM size observer boundary changed');
  return source.replace("window.addEventListener('DOMContentLoaded', () => {", 'const observe = () => {')
    .replace('  });\n  })();', "  };\n  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', observe, { once: true });\n  else observe();\n  })();");
}

if (require.main === module) {
  for (const [file, transform] of [['marshal.tsx', patch], ['injection.ts', patchSizeObserver]]) {
    const target = path.join(path.dirname(require.resolve('expo/package.json')), 'src/dom', file);
    const source = fs.readFileSync(target, 'utf8');
    const patched = transform(source);
    if (patched !== source) fs.writeFileSync(target, patched);
  }
}

module.exports = { patch, patchSizeObserver };
