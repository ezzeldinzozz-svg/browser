'use strict';

// Saved logins. Passwords are encrypted with Electron's safeStorage (macOS Keychain, Windows
// DPAPI, Linux libsecret/kwallet) and only decrypted at the moment they're filled, copied or
// shown. Stored in store.data.passwords as
//   { id, origin, username, password: base64 ciphertext, created, used }
// plus store.data.passwordNever: origins where the user chose "Never".

const { safeStorage } = require('electron');

let data = null;
let changed = () => {};

function init(storeData, onChange) {
  data = storeData;
  changed = onChange;
  data.passwords ||= [];
  data.passwordNever ||= [];
  data.passwordNextId ||= 1;
}

const available = () => safeStorage.isEncryptionAvailable();
const encrypt = (text) => safeStorage.encryptString(text).toString('base64');
const decrypt = (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64'));

// Only real login pages: https, or http on this machine (local development).
function savableOrigin(origin) {
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch {
    return false;
  }
}

const forOrigin = (origin) => data.passwords.filter((p) => p.origin === origin);
const find = (id) => data.passwords.find((p) => p.id === id) || null;
const isNever = (origin) => data.passwordNever.includes(origin);

// What a submitted login would do: 'save' (new), 'update' (new password for a saved username),
// or null (already saved, never-listed, or can't be stored).
function offerFor(origin, username, password) {
  if (!available() || !password || !savableOrigin(origin) || isNever(origin)) return null;
  const existing = forOrigin(origin).find((p) => p.username === username);
  if (!existing) return 'save';
  try {
    return decrypt(existing.password) === password ? null : 'update';
  } catch {
    return 'update';
  }
}

function save(origin, username, password) {
  const existing = forOrigin(origin).find((p) => p.username === username);
  if (existing) {
    existing.password = encrypt(password);
    existing.used = Date.now();
  } else {
    data.passwords.push({ id: data.passwordNextId++, origin, username, password: encrypt(password), created: Date.now(), used: Date.now() });
  }
  changed();
}

function never(origin) {
  if (!isNever(origin)) data.passwordNever.push(origin);
  changed();
}

function reveal(id) {
  const p = find(id);
  if (!p) return null;
  p.used = Date.now();
  return decrypt(p.password);
}

function remove(id) {
  data.passwords = data.passwords.filter((p) => p.id !== id);
  changed();
}

function removeNever(origin) {
  data.passwordNever = data.passwordNever.filter((o) => o !== origin);
  changed();
}

// The list for Settings: never includes passwords.
const list = () =>
  data.passwords
    .map(({ id, origin, username, created, used }) => ({ id, origin, username, created, used }))
    .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username));

module.exports = { init, available, savableOrigin, forOrigin, find, offerFor, save, never, reveal, remove, removeNever, list, neverList: () => [...data.passwordNever] };
