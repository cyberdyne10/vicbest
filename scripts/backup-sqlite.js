#!/usr/bin/env node
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.resolve(process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'vicbest.db'));
const backupRoot = path.resolve(process.env.SQLITE_BACKUP_DIR || path.join(__dirname, '..', 'backups'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupRoot, `vicbest-${stamp}.db`);
const keep = Number(process.env.SQLITE_BACKUP_KEEP || 14);

if (!fs.existsSync(path.dirname(dbPath))) {
  console.error(`Database directory does not exist: ${path.dirname(dbPath)}`);
  process.exit(1);
}
if (!fs.existsSync(backupRoot)) fs.mkdirSync(backupRoot, { recursive: true });

const db = new sqlite3.Database(dbPath);

function run(sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, (err) => (err ? reject(err) : resolve()));
  });
}

async function cleanupOldBackups() {
  if (!Number.isInteger(keep) || keep <= 0) return;
  const entries = fs.readdirSync(backupRoot)
    .filter((name) => name.startsWith('vicbest-') && name.endsWith('.db'))
    .map((name) => ({ name, filePath: path.join(backupRoot, name), mtime: fs.statSync(path.join(backupRoot, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  entries.slice(keep).forEach((entry) => fs.unlinkSync(entry.filePath));
}

(async () => {
  try {
    await run('PRAGMA wal_checkpoint(FULL)');
    const escapedPath = backupPath.replace(/'/g, "''");
    await run(`VACUUM INTO '${escapedPath}'`);
    await cleanupOldBackups();
    console.log(`SQLite backup created: ${backupPath}`);
  } catch (err) {
    console.error('SQLite backup failed', err.message || err);
    process.exitCode = 1;
  } finally {
    db.close();
  }
})();
