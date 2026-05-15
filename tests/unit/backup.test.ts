import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { initDatabase } from '../../src/db/schema.js';
import { BackupService, restoreIfNeeded } from '../../src/backup.js';
import { Vault } from '../../src/secrets/vault.js';

describe('Backup & Restore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiram-backup-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create a backup snapshot with DB and tools', async () => {
    const dbPath = path.join(tmpDir, 'hiram.db');
    const toolsDir = path.join(tmpDir, 'tools');
    const backupDir = path.join(tmpDir, 'backups');
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, 'test-plugin.ts'), 'export const plugin = {};');

    const db = initDatabase(dbPath);
    const vault = new Vault(db, 'test-key');
    vault.set('TEST_SECRET', 'secret-value');

    const backup = new BackupService(db, { backupDir, sqlitePath: dbPath, toolsDir, retain: 3 });
    const snapshotDir = await backup.run();

    // Verify snapshot exists.
    expect(fs.existsSync(snapshotDir)).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'hiram.db'))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'tools', 'test-plugin.ts'))).toBe(true);

    db.close();
  });

  it('should rotate old backups', async () => {
    const dbPath = path.join(tmpDir, 'hiram.db');
    const backupDir = path.join(tmpDir, 'backups');

    const db = initDatabase(dbPath);
    const backup = new BackupService(db, { backupDir, sqlitePath: dbPath, toolsDir: path.join(tmpDir, 'tools'), retain: 2 });

    // Create 4 backups.
    await backup.run();
    await backup.run();
    await backup.run();
    await backup.run();

    // Only 2 should remain (retain=2).
    const entries = fs.readdirSync(backupDir).filter((e) => e.startsWith('backup_'));
    expect(entries.length).toBe(2);

    db.close();
  });

  it('should restore from backup when DB is missing', async () => {
    const dbPath = path.join(tmpDir, 'hiram.db');
    const toolsDir = path.join(tmpDir, 'tools');
    const backupDir = path.join(tmpDir, 'backups');
    fs.mkdirSync(toolsDir, { recursive: true });

    // Create DB with data.
    const db = initDatabase(dbPath);
    const vault = new Vault(db, 'test-key');
    vault.set('RESTORE_TEST', 'important-value');

    // Backup.
    const backup = new BackupService(db, { backupDir, sqlitePath: dbPath, toolsDir, retain: 5 });
    await backup.run();
    db.close();

    // Delete the live DB.
    fs.unlinkSync(dbPath);
    // Also remove WAL/SHM if present.
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* */ }

    expect(fs.existsSync(dbPath)).toBe(false);

    // Restore.
    const restored = await restoreIfNeeded({ backupDir, sqlitePath: dbPath, toolsDir, retain: 5 });
    expect(restored).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);

    // Verify data survived.
    const db2 = initDatabase(dbPath);
    const vault2 = new Vault(db2, 'test-key');
    expect(vault2.get('RESTORE_TEST')).toBe('important-value');
    db2.close();
  });

  it('should not restore when DB is healthy', async () => {
    const dbPath = path.join(tmpDir, 'hiram.db');
    const db = initDatabase(dbPath);
    db.close();

    const restored = await restoreIfNeeded({
      backupDir: path.join(tmpDir, 'backups'),
      sqlitePath: dbPath,
      toolsDir: path.join(tmpDir, 'tools'),
      retain: 5,
    });
    expect(restored).toBe(false);
  });
});
