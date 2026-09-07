const MAX_MERMAID_SOURCE_LENGTH = 20_000;
const MAX_MERMAID_SVG_LENGTH = 2_000_000;
const SAFE_TAGS = new Set([
  'circle', 'defs', 'g', 'line', 'marker', 'polygon', 'polyline',
  'rect', 'svg', 'text', 'tspan',
]);
const SAFE_ATTRIBUTES = new Set([
  'class', 'cx', 'cy', 'data-actor', 'data-arrow-end', 'data-arrow-head',
  'data-arrow-start', 'data-cardinality1', 'data-cardinality2', 'data-entity1',
  'data-entity2', 'data-from', 'data-id', 'data-identifying', 'data-label',
  'data-line-style', 'data-marker-at', 'data-self', 'data-shape', 'data-style',
  'data-to', 'data-type', 'dy', 'fill', 'font-size', 'font-style', 'font-weight',
  'height', 'id', 'marker-end', 'marker-start', 'markerHeight', 'markerWidth',
  'orient', 'points', 'r', 'refX', 'refY', 'rx', 'ry', 'stroke',
  'stroke-dasharray', 'stroke-linejoin', 'stroke-width', 'text-anchor', 'viewBox',
  'width', 'x', 'x1', 'x2', 'xmlns', 'y', 'y1', 'y2',
]);
const SAFE_COLOR = /^(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%a-z]+\)|var\(--[a-z0-9-]+\))$/i;

function assertSafeColor(value) {
  if (typeof value !== 'string' || !SAFE_COLOR.test(value.trim())) {
    throw new Error('Unsafe Mermaid color');
  }
  return value.trim();
}

function assertMermaidSource(source) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('Empty Mermaid source');
  if (source.length > MAX_MERMAID_SOURCE_LENGTH) throw new Error('Mermaid source is too large');
  if (/^\s*xychart(?:-beta)?\b/i.test(source)) {
    throw new Error('XY charts are not supported in Chat yet');
  }
}

function inspectSvg(svg) {
  for (const match of svg.matchAll(/<\/?([a-z][\w:-]*)\b/gi)) {
    if (!SAFE_TAGS.has(match[1])) throw new Error(`Unsafe Mermaid SVG tag: ${match[1]}`);
  }

  for (const tag of svg.matchAll(/<([a-z][\w:-]*)\b([^>]*)>/gi)) {
    for (const attribute of tag[2].matchAll(/\s([a-zA-Z_:][-\w:.]*)\s*=/g)) {
      if (!SAFE_ATTRIBUTES.has(attribute[1])) {
        throw new Error(`Unsafe Mermaid SVG attribute: ${attribute[1]}`);
      }
    }
  }
}

/**
 * Convert beautiful-mermaid's browser SVG into one safe in both Electron and
 * react-native-svg. The renderer supplies the geometry; this boundary removes
 * remote fonts/CSS and permits only the SVG vocabulary that renderer emits.
 */
function prepareChatMermaidSvg(svg, colors, idPrefix = 'cas-mermaid') {
  if (typeof svg !== 'string' || !svg.startsWith('<svg') || svg.length > MAX_MERMAID_SVG_LENGTH) {
    throw new Error('Invalid Mermaid SVG');
  }

  const palette = {
    background: assertSafeColor(colors.background),
    text: assertSafeColor(colors.text),
    muted: assertSafeColor(colors.muted),
    line: assertSafeColor(colors.line || colors.muted),
    accent: assertSafeColor(colors.accent),
    surface: assertSafeColor(colors.surface),
    border: assertSafeColor(colors.border),
  };
  const variables = {
    '--accent': palette.accent,
    '--bg': palette.background,
    '--border': palette.border,
    '--fg': palette.text,
    '--line': palette.line,
    '--muted': palette.muted,
    '--surface': palette.surface,
    '--_arrow': palette.accent,
    '--_group-fill': palette.background,
    '--_group-hdr': palette.surface,
    '--_inner-stroke': palette.border,
    '--_key-badge': palette.surface,
    '--_line': palette.line,
    '--_node-fill': palette.surface,
    '--_node-stroke': palette.border,
    '--_text': palette.text,
    '--_text-faint': palette.muted,
    '--_text-muted': palette.muted,
    '--_text-sec': palette.muted,
  };

  let safe = svg
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/(<svg\b[^>]*)\sstyle="[^"]*"/i, '$1')
    .replace(/var\((--[\w-]+)(?:,[^)]*)?\)/g, (match, name) => variables[name] || match);
  const allowedThemeVariables = new Set(Object.values(palette).filter((value) => value.startsWith('var(')));
  if ([...safe.matchAll(/var\(--[a-z0-9-]+\)/gi)].some((match) => !allowedThemeVariables.has(match[0]))
    || /\sstyle\s*=|javascript:|data:text\/html/i.test(safe)) {
    throw new Error('Unsupported Mermaid SVG styling');
  }

  inspectSvg(safe);

  const prefix = String(idPrefix).replace(/[^a-z0-9_-]/gi, '') || 'cas-mermaid';
  const ids = [...safe.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  for (const id of ids) {
    const namespaced = `${prefix}-${id}`;
    safe = safe
      .replace(new RegExp(`id="${id}"`, 'g'), `id="${namespaced}"`)
      .replace(new RegExp(`url\\(#${id}\\)`, 'g'), `url(#${namespaced})`);
  }
  safe = safe.replace('<svg ', '<svg font-family="system-ui, sans-serif" ');

  const viewBox = /\bviewBox="[\d.-]+[ ,]+[\d.-]+[ ,]+([\d.]+)[ ,]+([\d.]+)"/.exec(safe);
  if (!viewBox) throw new Error('Mermaid SVG has no viewBox');
  return { svg: safe, width: Number(viewBox[1]), height: Number(viewBox[2]) };
}

module.exports = {
  MAX_MERMAID_SOURCE_LENGTH,
  assertMermaidSource,
  prepareChatMermaidSvg,
};
