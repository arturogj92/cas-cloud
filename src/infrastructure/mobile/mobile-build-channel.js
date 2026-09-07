const DEVELOPMENT_CHANNEL = 'development';
const PRODUCTION_CHANNEL = 'production';
const DEVELOPMENT_MOBILE_WEB_ORIGIN = 'https://develop.codeagentswarm-mobile.pages.dev';
const PRODUCTION_MOBILE_WEB_ORIGIN = 'https://web.codeagentswarm.com';

function resolveMobileBuildChannel(channel) {
  return channel === PRODUCTION_CHANNEL ? PRODUCTION_CHANNEL : DEVELOPMENT_CHANNEL;
}

function mobileWebOrigin(channel) {
  if (process.env.CAS_WEB_ORIGIN) {
    const value = process.env.CAS_WEB_ORIGIN;
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password
      || (url.protocol !== 'https:' && !(url.protocol === 'http:'
        && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw new Error('CAS_WEB_ORIGIN must be an HTTPS origin (HTTP is allowed on loopback)');
    }
    return value;
  }
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
