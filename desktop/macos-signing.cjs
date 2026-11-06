const { createPrivateKey } = require('node:crypto');

function requireMacSigning(env) {
  const names = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_TEAM_ID'];
  const missing = names.filter((name) => !String(env[name] || '').trim());
  if (missing.length) throw new Error('Missing macOS signing configuration: ' + missing.join(', '));
  if (!/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID) || !/^[A-Z0-9]{10}$/.test(env.APPLE_API_KEY_ID))
    throw new Error('Apple team and API key identifiers must contain 10 uppercase letters or digits.');
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(env.APPLE_API_ISSUER))
    throw new Error('Apple API issuer must be a UUID.');
  if (env.CSC_IDENTITY_AUTO_DISCOVERY === 'false' || env.CSC_NAME?.trim() === '-')
    throw new Error('Developer ID builds cannot disable identity discovery or use ad-hoc signing.');
  if (env.APPLE_ID || env.APPLE_APP_SPECIFIC_PASSWORD || env.APPLE_KEYCHAIN_PROFILE)
    throw new Error('Use only the configured Apple API key authentication for this build.');
}

function decodeNotaryKey(value) {
  const encoded = String(value || '').replace(/\s/g, '');
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw new Error('Apple API key must be a base64-encoded private .p8 key.');
  const bytes = Buffer.from(encoded, 'base64');
  try {
    if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '') ||
        !bytes.toString('utf8').includes('-----BEGIN PRIVATE KEY-----')) throw Error();
    createPrivateKey({ key: bytes, format: 'pem', type: 'pkcs8' });
  } catch {
    throw new Error('Apple API key is not a valid PKCS#8 private .p8 key.');
  }
  return bytes;
}

function macDistributionConfig(base, env = process.env) {
  requireMacSigning(env);
  const config = structuredClone(base);
  // electron-builder imports CSC_LINK into a temporary keychain and selects Developer ID.
  delete config.mac.identity;
  config.forceCodeSigning = true;
  config.mac.hardenedRuntime = true;
  config.mac.notarize = true;
  config.dmg = { ...config.dmg, sign: true };
  return config;
}
module.exports = { requireMacSigning, decodeNotaryKey, macDistributionConfig };
