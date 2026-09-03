const MODEL_USAGE_LIMIT_CODE = 'model_usage_limit_reached';
const MODEL_USAGE_LIMIT_MESSAGE = "This model's usage limit has been reached. Switch models or try again after the limit resets.";

const USAGE_LIMIT_CODES = new Set([
  'billinghardlimitreached',
  'creditsexhausted',
  'insufficientquota',
  'modelusagelimitreached',
  'quotaexhausted',
  'ratelimit',
  'ratelimited',
  'ratelimiterror',
  'ratelimitreached',
  'resourceexhausted',
  'usagelimit',
  'usagelimitexceeded',
  'workspaceownerusagelimitreached',
  'workspacememberusagelimitreached'
]);

const USAGE_LIMIT_MESSAGE_PATTERN = /(?:credit balance is too low|credits? (?:have been )?exhausted|insufficient[ _-]quota|too many requests|(?:model|rate|usage) limit (?:has been )?(?:exceeded|reached)|(?:hit|reached|exceeded) (?:(?:your|the) )?(?:model|rate|usage) limit|quota (?:has been )?(?:exceeded|exhausted|reached)|resource[ _-]exhausted)/i;

function structuredErrorInfoValues(value) {
  if (!value || typeof value !== 'object') return [value];
  return Object.entries(value).flatMap(([kind, detail]) => [
    kind,
    typeof detail === 'string' || typeof detail === 'number' ? detail : undefined,
    detail?.httpStatusCode,
    detail?.statusCode,
    detail?.http_status
  ]);
}

function errorSignalValues(event) {
  const payload = event?.payload || {};
  const payloadErrorData = payload.errorData || {};
  const detail = payload.detail || {};
  const detailError = detail.error || {};
  const detailData = detail.data || {};
  const detailErrorData = detailError.data || {};
  const rawPayload = event?.raw?.payload || {};
  const rawError = rawPayload.error || rawPayload.turn?.error || {};
  return [
    payload.message,
    payload.errorMessage,
    ...structuredErrorInfoValues(payload.code),
    ...structuredErrorInfoValues(payload.errorCode),
    payloadErrorData,
    payloadErrorData.message,
    payloadErrorData.code,
    payloadErrorData.errorCode,
    payloadErrorData.httpStatusCode,
    payloadErrorData.statusCode,
    payloadErrorData.http_status,
    payloadErrorData.reason,
    payloadErrorData.stopReason,
    detail.code,
    detail.message,
    detail.errorCode,
    detail.httpStatusCode,
    detail.statusCode,
    detail.http_status,
    ...structuredErrorInfoValues(detail.codexErrorInfo),
    detail.stopReason,
    detailError.code,
    detailError.message,
    detailError.errorCode,
    detailError.httpStatusCode,
    detailError.statusCode,
    detailError.http_status,
    ...structuredErrorInfoValues(detailError.codexErrorInfo),
    detailData.code,
    detailData.message,
    detailData.errorCode,
    detailData.httpStatusCode,
    detailData.statusCode,
    detailData.http_status,
    detailData.reason,
    detailData.stopReason,
    detailErrorData.code,
    detailErrorData.message,
    detailErrorData.errorCode,
    detailErrorData.httpStatusCode,
    detailErrorData.statusCode,
    detailErrorData.http_status,
    detailErrorData.reason,
    detailErrorData.stopReason,
    rawPayload.stopReason,
    rawError.message,
    rawError.code,
    rawError.errorCode,
    rawError.httpStatusCode,
    rawError.statusCode,
    rawError.http_status,
    ...structuredErrorInfoValues(rawError.codexErrorInfo)
  ];
}

function isModelUsageLimitError(event) {
  const values = errorSignalValues(event);
  if (values.some((value) => typeof value === 'string' && USAGE_LIMIT_MESSAGE_PATTERN.test(value))) {
    return true;
  }
  if (values.some((value) => (
    typeof value === 'string'
    && USAGE_LIMIT_CODES.has(value.toLowerCase().replace(/[^a-z0-9]/g, ''))
  ))) return true;
  if (values.some((value) => Number(value) === 429)) return true;
  return event?.provider === 'grok' && values.some((value) => Number(value) === -32003);
}

function normalizeProviderErrorEvent(event) {
  if (!event || !['runtime.error', 'turn.completed', 'session.exited'].includes(event.type)) {
    return event;
  }
  if (!isModelUsageLimitError(event)) return event;

  const payload = { ...(event.payload || {}), code: MODEL_USAGE_LIMIT_CODE };
  if (event.type === 'runtime.error') {
    payload.message = MODEL_USAGE_LIMIT_MESSAGE;
    payload.class = 'usage_limit';
  } else if (event.type === 'turn.completed') {
    payload.errorMessage = MODEL_USAGE_LIMIT_MESSAGE;
    payload.errorCode = MODEL_USAGE_LIMIT_CODE;
  } else {
    payload.reason = MODEL_USAGE_LIMIT_MESSAGE;
    payload.errorCode = MODEL_USAGE_LIMIT_CODE;
  }
  return { ...event, payload };
}

module.exports = {
  MODEL_USAGE_LIMIT_CODE,
  MODEL_USAGE_LIMIT_MESSAGE,
  isModelUsageLimitError,
  normalizeProviderErrorEvent
};
