const DEVELOPMENT_CHANNEL = 'development';
const PRODUCTION_CHANNEL = 'production';
const DEVELOPMENT_MOBILE_WEB_ORIGIN = 'https://develop.codeagentswarm-mobile.pages.dev';
const PRODUCTION_MOBILE_WEB_ORIGIN = 'https://codeagentswarm-mobile.pages.dev';

function resolveMobileBuildChannel(channel) {
  return channel === PRODUCTION_CHANNEL ? PRODUCTION_CHANNEL : DEVELOPMENT_CHANNEL;
}

function mobileWebOrigin(channel) {
  return resolveMobileBuildChannel(channel) === PRODUCTION_CHANNEL
    ? PRODUCTION_MOBILE_WEB_ORIGIN
    : DEVELOPMENT_MOBILE_WEB_ORIGIN;
}

function mobileRuntimeSettingKey(channel, accountKey) {
  return resolveMobileBuildChannel(channel) === PRODUCTION_CHANNEL
    ? `mobile_runtime_id_${accountKey}`
    : `mobile_runtime_id_development_${accountKey}`;
}

module.exports = {
  DEVELOPMENT_CHANNEL,
  PRODUCTION_CHANNEL,
  DEVELOPMENT_MOBILE_WEB_ORIGIN,
  PRODUCTION_MOBILE_WEB_ORIGIN,
  resolveMobileBuildChannel,
  mobileWebOrigin,
  mobileRuntimeSettingKey,
};
