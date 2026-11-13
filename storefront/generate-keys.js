// generate-keys.js — run once with `node generate-keys.js`
const { generateKeyPairSync } = require('crypto');

const { publicKey, privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  publicKeyEncoding: { format: 'jwk' },
  privateKeyEncoding: { format: 'jwk' },
});

console.log("PUBLIC (goes to frontend):\n", JSON.stringify(publicKey));
console.log("\nPRIVATE (goes in BOTH backends' .env):\n", JSON.stringify(privateKey));