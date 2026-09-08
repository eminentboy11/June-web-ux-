'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const KDF_SALT = 'june-db:installation-ed25519-seed:v1';
const PKCS8 = Buffer.from('302e020100300506032b657004220420','hex');
const AUDIENCE = 'https://dbapi-ociq.onrender.com';
const PURPOSE = 'june-db:provision-or-authenticate:v1';

function validateSecret(secret) {
  // These checks exclude obvious weak inputs, not a mathematical entropy test.
  if(typeof secret!=='string' || Buffer.byteLength(secret)<32 || Buffer.byteLength(secret)>256 ||
     secret!==secret.trim() || /[\u0000-\u001f\u007f]/u.test(secret) || new Set(secret).size<10 ||
     /^(.{1,16})\1+$/u.test(secret)) {
    throw new Error('DB must be a unique strong secret: 32–256 UTF-8 bytes, without surrounding whitespace or control characters; use a securely generated random value');
  }
  return true;
}
function signingMessage(c) {
  return Buffer.from(JSON.stringify([PURPOSE,AUDIENCE,c.challengeId,c.publicKey,c.nonce,c.expiresAt]),'utf8');
}
async function deriveIdentity(secret) {
  validateSecret(secret);
  const input=Buffer.from(secret,'utf8');let seed,der;
  try {
    seed=await scrypt(input,KDF_SALT,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
    der=Buffer.concat([PKCS8,seed]);
    const privateKey=crypto.createPrivateKey({key:der,format:'der',type:'pkcs8'});
    const publicDer=crypto.createPublicKey(privateKey).export({format:'der',type:'spki'});
    const publicKey=publicDer.subarray(-32).toString('base64url');
    // Closure contains the KeyObject. No private seed/key export is exposed.
    return Object.freeze({publicKey,sign:challenge=>crypto.sign(null,signingMessage(challenge),privateKey).toString('base64url')});
  } finally {input.fill(0);seed?.fill(0);der?.fill(0);}
}
module.exports={deriveIdentity,validateSecret,signingMessage,AUDIENCE,PURPOSE,KDF_SALT};
