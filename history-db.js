'use strict';

// Browsing history in SQLite (node:sqlite, built into Electron's Node), in History.sqlite in the
// profile folder. Replaces the old `history` array in browser-data.json, which was rewritten in
// full on every page visit.
//
//   visits      one row per visit (url, title, time in Unix ms)
//   pages       one row per URL: latest title, visit count, last visit (suggestions, tiles)
//   visits_fts  FTS5 full-text index over visit titles and URLs (History page search)

const { DatabaseSync } = require('node:sqlite');

const MAX_VISITS = 200000; // oldest visits beyond this are dropped

let db = null;
let q = null; // prepared statements

function open(file) {
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      time INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS visits_time ON visits (time DESC);
    CREATE INDEX IF NOT EXISTS visits_url ON visits (url);
    CREATE TABLE IF NOT EXISTS pages (
      url TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      visits INTEGER NOT NULL DEFAULT 0,
      last INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS pages_last ON pages (last DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS visits_fts USING fts5(
      title, url, content = 'visits', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS visits_ai AFTER INSERT ON visits BEGIN
      INSERT INTO visits_fts (rowid, title, url) VALUES (new.id, new.title, new.url);
    END;
    CREATE TRIGGER IF NOT EXISTS visits_ad AFTER DELETE ON visits BEGIN
      INSERT INTO visits_fts (visits_fts, rowid, title, url) VALUES ('delete', old.id, old.title, old.url);
    END;
    CREATE TRIGGER IF NOT EXISTS visits_au AFTER UPDATE ON visits BEGIN
      INSERT INTO visits_fts (visits_fts, rowid, title, url) VALUES ('delete', old.id, old.title, old.url);
      INSERT INTO visits_fts (rowid, title, url) VALUES (new.id, new.title, new.url);
    END;
  `);
  q = {
    latest: db.prepare('SELECT id, url FROM visits ORDER BY time DESC, id DESC LIMIT 1'),
    insert: db.prepare('INSERT INTO visits (url, title, time) VALUES (?, ?, ?)'),
    touch: db.prepare('UPDATE visits SET time = ? WHERE id = ?'),
    upsertPage: db.prepare(`
      INSERT INTO pages (url, title, visits, last) VALUES (?, ?, 1, ?)
      ON CONFLICT (url) DO UPDATE SET visits = visits + 1, last = MAX(last, excluded.last),
        title = CASE WHEN excluded.last >= last AND excluded.title != '' THEN excluded.title ELSE title END`),
    touchPage: db.prepare('UPDATE pages SET last = MAX(last, ?) WHERE url = ?'),
    setTitle: db.prepare(`UPDATE visits SET title = ? WHERE id IN (SELECT id FROM visits WHERE url = ? ORDER BY time DESC LIMIT 1)`),
    setPageTitle: db.prepare('UPDATE pages SET title = ? WHERE url = ?'),
    recent: db.prepare('SELECT url, title, time FROM visits WHERE time < ? ORDER BY time DESC, id DESC LIMIT ?'),
    search: db.prepare(`
      SELECT v.url AS url, v.title AS title, v.time AS time FROM visits_fts
      JOIN visits v ON v.id = visits_fts.rowid
      WHERE visits_fts MATCH ? AND v.time < ? ORDER BY v.time DESC LIMIT ?`),
    pagesLike: db.prepare(`
      SELECT url, title, visits, last FROM pages WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
      ORDER BY last DESC LIMIT ?`),
    topPages: db.prepare('SELECT url, title, visits, last FROM pages WHERE last > ? ORDER BY visits DESC, last DESC LIMIT ?'),
    recentPages: db.prepare('SELECT url, title, last FROM pages ORDER BY last DESC LIMIT ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM visits'),
    has: db.prepare('SELECT 1 FROM visits WHERE url = ? AND time = ? LIMIT 1'),
    all: db.prepare('SELECT url, title, time FROM visits ORDER BY time DESC'),
  };
  if (q.count.get().n > MAX_VISITS * 1.1) prune();
}

const transaction = (fn) => {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
};

// A page visit. Visiting the same URL again right away (reloads, redirects to itself) only
// refreshes the time of that visit.
function addVisit(url, title, time = Date.now()) {
  transaction(() => {
    const latest = q.latest.get();
    if (latest && latest.url === url) {
      q.touch.run(time, latest.id);
      q.touchPage.run(time, url);
    } else {
      q.insert.run(url, title || '', time);
      q.upsertPage.run(url, title || '', time);
    }
  });
}

function updateTitle(url, title) {
  if (!title) return;
  q.setTitle.run(title, url);
  q.setPageTitle.run(title, url);
}

// History page: newest first, `before` (Unix ms) for the next page; `query` uses the
// full-text index (every word, as a prefix).
function list({ query = '', before = Number.MAX_SAFE_INTEGER, limit = 300 } = {}) {
  const words = String(query).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.length) return q.recent.all(before, limit);
  const match = words.map((w) => `"${w}"*`).join(' ');
  return q.search.all(match, before, limit);
}

// Address bar: pages whose URL or title contains the text, most recent first.
function pagesMatching(text, limit = 300) {
  const like = `%${String(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return q.pagesLike.all(like, like, limit);
}

// New tab tiles: most visited pages of the last 90 days.
function topPages(limit = 50) {
  return q.topPages.all(Date.now() - 90 * 86400000, limit);
}

function recentPages(limit = 10) {
  return q.recentPages.all(limit);
}

function removeUrl(url) {
  transaction(() => {
    db.prepare('DELETE FROM visits WHERE url = ?').run(url);
    db.prepare('DELETE FROM pages WHERE url = ?').run(url);
  });
}

// Every visit whose site (host without "www.") is `site`, as siteOf() in main.js decides.
function removeWhere(test) {
  const urls = db.prepare('SELECT url FROM pages').all().map((r) => r.url).filter(test);
  transaction(() => {
    const visits = db.prepare('DELETE FROM visits WHERE url = ?');
    const pages = db.prepare('DELETE FROM pages WHERE url = ?');
    for (const url of urls) {
      visits.run(url);
      pages.run(url);
    }
  });
  return urls.length;
}

function removeBefore(time) {
  transaction(() => {
    db.prepare('DELETE FROM visits WHERE time < ?').run(time);
    rebuildPages();
  });
}

function removeSince(time) {
  transaction(() => {
    db.prepare('DELETE FROM visits WHERE time >= ?').run(time);
    rebuildPages();
  });
}

function clear() {
  transaction(() => {
    db.exec('DELETE FROM visits; DELETE FROM pages;');
  });
  db.exec("INSERT INTO visits_fts (visits_fts) VALUES ('rebuild')");
}

function rebuildPages() {
  db.exec(`
    DELETE FROM pages;
    INSERT INTO pages (url, title, visits, last)
      SELECT v.url, (SELECT title FROM visits t WHERE t.url = v.url ORDER BY t.time DESC LIMIT 1), COUNT(*), MAX(v.time)
      FROM visits v GROUP BY v.url;
  `);
}

// Many visits at once (imports, migration from browser-data.json); skips exact duplicates.
function importVisits(rows) {
  let added = 0;
  transaction(() => {
    for (const r of rows) {
      if (!r || !r.url || !(r.time > 0) || q.has.get(r.url, r.time)) continue;
      q.insert.run(r.url, r.title || '', r.time);
      added++;
    }
    rebuildPages();
  });
  if (q.count.get().n > MAX_VISITS * 1.1) prune();
  return added;
}

function prune() {
  transaction(() => {
    db.prepare('DELETE FROM visits WHERE id IN (SELECT id FROM visits ORDER BY time DESC LIMIT -1 OFFSET ?)').run(MAX_VISITS);
    rebuildPages();
  });
}

const all = () => q.all.all();
const count = () => q.count.get().n;
const close = () => db && db.close();

module.exports = { open, addVisit, updateTitle, list, pagesMatching, topPages, recentPages, removeUrl, removeWhere, removeBefore, removeSince, clear, importVisits, all, count, close };
