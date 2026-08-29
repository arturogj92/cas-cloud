/**
 * Split Cursor ACP model SKUs into a selectable name plus sibling effort/fast
 * options. Cursor advertises either base ids (`grok-4.6`) with separate
 * configOptions, or exploded variants (`grok-4.6[effort=high,fast=true]`).
 * Chat always presents the base name; effort stays a separate control.
 */

const THOUGHT_PARAM_IDS = Object.freeze([
  'effort',
  'reasoning',
  'thinking',
  'thought_level',
  'reasoning_effort'
]);

function parseCursorModelId(modelId) {
  const raw = String(modelId || '').trim();
  const match = raw.match(/^([^[\]]+)\[(.*)\]$/);
  if (!match) {
    return { baseId: raw, variantId: raw, params: {} };
  }
  const params = {};
  for (const part of match[2].split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!key) continue;
    params[key] = trimmed.slice(separator + 1).trim();
  }
  return {
    baseId: match[1].trim(),
    variantId: raw,
    params
  };
}

function cursorUsesExplodedIds(models) {
  return (Array.isArray(models) ? models : []).some((entry) => {
    const id = entry && (entry.modelId || entry.id);
    return typeof id === 'string' && id.includes('[');
  });
}

function labelForParamValue(value) {
  if (value === 'xhigh') return 'Extra high';
  if (value === 'true') return 'On';
  if (value === 'false') return 'Off';
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function thoughtParamId(params) {
  return THOUGHT_PARAM_IDS.find((id) => Object.prototype.hasOwnProperty.call(params, id)) || null;
}

function uniqueParamValues(variants, paramId) {
  const seen = new Set();
  const values = [];
  for (const variant of variants) {
    const value = variant.params && variant.params[paramId];
    if (value == null || value === '' || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

function descriptorFromValues(id, label, values, currentValue) {
  if (values.length < 2 && !currentValue) return null;
  const options = (values.length ? values : [currentValue]).filter(Boolean).map((value) => ({
    id: value,
    label: labelForParamValue(value)
  }));
  if (!options.length) return null;
  return {
    id,
    label,
    type: 'select',
    options,
    ...(currentValue ? { currentValue } : {})
  };
}

function descriptorsFromVariants(variants, currentParams) {
  const thoughtId = thoughtParamId(currentParams)
    || variants.map((variant) => thoughtParamId(variant.params || {})).find(Boolean);
  const descriptors = [];
  if (thoughtId) {
    const values = uniqueParamValues(variants, thoughtId);
    const descriptor = descriptorFromValues(
      thoughtId,
      'Reasoning',
      values,
      currentParams[thoughtId]
    );
    // A single advertised SKU still shows the current effort so the composer
    // has a name control and an effort control, even before Cursor lists
    // every level. Parameterized sessions replace this with the full list.
    if (descriptor) descriptors.push(descriptor);
  }
  const fastValues = uniqueParamValues(variants, 'fast');
  if (fastValues.length >= 2) {
    const fast = descriptorFromValues('fast', 'Fast', fastValues, currentParams.fast);
    if (fast) descriptors.push(fast);
  }
  return descriptors;
}

function preferredName(entry, parsed) {
  const name = String((entry && entry.name) || '').trim();
  if (!name || name === parsed.variantId) return parsed.baseId;
  return name;
}

/**
 * @param {Object} input
 * @param {Array<Object>} [input.models] ACP `models.availableModels`.
 * @param {Array<Object>} [input.optionDescriptors] Already mapped session options.
 * @param {string} [input.currentModelId]
 * @returns {Array<Object>} Catalog rows keyed by base model id.
 */
function buildCursorModelCatalog({
  models = [],
  optionDescriptors = [],
  currentModelId = ''
} = {}) {
  const current = parseCursorModelId(currentModelId);
  const groups = new Map();

  for (const entry of Array.isArray(models) ? models : []) {
    const rawId = entry && (entry.modelId || entry.id);
    if (typeof rawId !== 'string' || !rawId.trim()) continue;
    const parsed = parseCursorModelId(rawId);
    const group = groups.get(parsed.baseId) || {
      id: parsed.baseId,
      name: parsed.baseId,
      variants: [],
      resolvedModel: parsed.variantId
    };
    group.variants.push({
      ...parsed,
      name: preferredName(entry, parsed)
    });
    const nextName = preferredName(entry, parsed);
    if (group.name === group.id && nextName !== group.id) group.name = nextName;
    else if (nextName && nextName !== parsed.variantId) group.name = nextName;
    if (parsed.variantId === current.variantId) {
      group.resolvedModel = parsed.variantId;
    }
    groups.set(parsed.baseId, group);
  }

  return Array.from(groups.values()).map((group) => {
    const isCurrent = group.id === current.baseId;
    const currentVariant = isCurrent
      ? (group.variants.find((variant) => variant.variantId === current.variantId)
        || group.variants[0])
      : group.variants[0];
    const synthesized = descriptorsFromVariants(
      group.variants,
      (currentVariant && currentVariant.params) || {}
    );
    const descriptors = optionDescriptors.length ? optionDescriptors : synthesized;
    return {
      id: group.id,
      name: group.name || group.id,
      current: isCurrent,
      ...(group.resolvedModel && group.resolvedModel !== group.id
        ? { resolvedModel: group.resolvedModel }
        : {}),
      capabilities: { optionDescriptors: descriptors }
    };
  }).filter((entry) => entry.id);
}

function cursorWireModelId(catalog, selectedId) {
  const row = (Array.isArray(catalog) ? catalog : []).find((entry) => entry && entry.id === selectedId);
  return (row && row.resolvedModel) || selectedId;
}

function paramsMatch(left, right) {
  const keys = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
  for (const key of keys) {
    if (String((left && left[key]) || '') !== String((right && right[key]) || '')) return false;
  }
  return true;
}

function cursorWireIdForParamChange(models, currentModelId, paramId, value) {
  if (!paramId || !cursorUsesExplodedIds(models)) return null;
  const current = parseCursorModelId(currentModelId);
  if (!current.baseId) return null;
  const wanted = { ...current.params, [paramId]: String(value) };
  const variants = (Array.isArray(models) ? models : [])
    .map((entry) => parseCursorModelId(entry && (entry.modelId || entry.id)))
    .filter((parsed) => parsed.baseId === current.baseId && parsed.variantId);
  const exact = variants.find((parsed) => paramsMatch(parsed.params, wanted));
  if (exact) return exact.variantId;
  const loose = variants.find((parsed) => parsed.params[paramId] === String(value));
  return loose ? loose.variantId : null;
}

function cursorEffortFromParsed(parsed) {
  if (!parsed || !parsed.params) return '';
  const id = thoughtParamId(parsed.params);
  return id ? parsed.params[id] : '';
}

module.exports = {
  THOUGHT_PARAM_IDS,
  parseCursorModelId,
  cursorUsesExplodedIds,
  buildCursorModelCatalog,
  cursorWireModelId,
  cursorWireIdForParamChange,
  cursorEffortFromParsed
};
