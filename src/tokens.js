// Two kinds of opaque string in this app, both HMAC-based so nothing has to be
// stored to validate them:
//
//   locationToken  random, printed into a QR. Random rather than "E02" so a
//                  resident cannot edit the URL and dispatch housekeeping to a
//                  cab they are not standing in.
//   signed value   MARK SERVICED links and the dashboard session cookie.
'use strict';

const crypto = require('crypto');
const { config } = require('./config');

// Ambiguous characters removed: no 0/O, 1/l/I. These end up hand-typed or
// read aloud over a radio more often than you would expect.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function randomToken(length = 7) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hmac(payload) {
  return b64url(crypto.createHmac('sha256', config.secret).update(payload).digest());
}

// Produces "<payload>.<signature>". Optional ttlMs bounds how long it is valid.
function sign(payload, ttlMs) {
  const expiry = ttlMs ? String(Date.now() + ttlMs) : '0';
  const body = `${b64url(payload)}.${expiry}`;
  return `${body}.${hmac(body)}`;
}

// Returns the payload string, or null if tampered, malformed, or expired.
function verify(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encoded, expiry, signature] = parts;
  const expected = hmac(`${encoded}.${expiry}`);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  if (expiry !== '0' && Date.now() > Number(expiry)) return null;

  return Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

module.exports = { randomToken, sign, verify };
