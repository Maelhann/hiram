import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// BackupService — periodic + on-shutdown backups of the SQLite database and
// the plugin tools directory.
//
// Uses SQLite's .backup() API for consistent, lock-free database snapshots.
// Copies the tools/ directory alongside the DB snapshot.
// Rotates old backups to stay within a configurable retention count.
// ---------------------------------------------------------------------------

export interface BackupConfig {
  /** Directory where backups are stored. */
  backupDir: string;
  /** Path to the live SQLite database file. */
  sqlitePath: string;
  /** Path to the tools directory (plugin .ts/.js files). */
  toolsDir: string;
  /** Number of backups to retain. Oldest are pruned. */
  retain: number;
}

export class BackupService {
  constructor(
    private db: Database.Database,
    private config: BackupConfig,
  ) {}

  /** Run a full backup: database snapshot + tools directory copy. */
  async run(): Promise<string> {
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .replace('Z', '');
    const snapshotDir = path.join(this.config.backupDir, `backup_${timestamp}`);

    await fs.mkdir(snapshotDir, { recursive: true });

    // 1. SQLite backup via the online backup API.
    const dbDest = path.join(snapshotDir, 'hiram.db');
    await this.db.backup(dbDest);

    // 2. Copy the tools directory (plugin sources + compiled JS).
    const toolsDest = path.join(snapshotDir, 'tools');
    await copyDir(this.config.toolsDir, toolsDest);

    // 3. Rotate old backups.
    await this.rotate();

    console.log(`Backup complete: ${snapshotDir}`);
    return snapshotDir;
  }

  /** Remove oldest backups beyond the retention limit. */
  private async rotate(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.config.backupDir);
    } catch {
      return;
    }

    const backups = entries
      .filter((e) => e.startsWith('backup_'))
      .sort(); // lexicographic = chronological thanks to ISO timestamp

    const toRemove = backups.slice(0, Math.max(0, backups.length - this.config.retain));
    for (const dir of toRemove) {
      const full = path.join(this.config.backupDir, dir);
      await fs.rm(full, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Pre-boot restore — runs BEFORE the database is opened.
//
// Checks if the database exists and is healthy. If not, finds the most recent
// backup and restores both the database and the tools directory.
// ---------------------------------------------------------------------------

export async function restoreIfNeeded(config: BackupConfig): Promise<boolean> {
  const dbHealthy = await isDatabaseHealthy(config.sqlitePath);

  if (dbHealthy) return false;

  const latestBackup = await findLatestBackup(config.backupDir);
  if (!latestBackup) {
    console.warn('Database missing/corrupt and no backups found. Starting fresh.');
    return false;
  }

  console.log(`Restoring from backup: ${latestBackup}`);

  // Restore database.
  const backedUpDb = path.join(latestBackup, 'hiram.db');
  await fs.mkdir(path.dirname(config.sqlitePath), { recursive: true });
  await fs.copyFile(backedUpDb, config.sqlitePath);

  // Also restore any WAL/SHM leftovers from the old corrupt DB.
  for (const suffix of ['-wal', '-shm']) {
    await fs.rm(config.sqlitePath + suffix, { force: true });
  }

  // Restore tools directory.
  const backedUpTools = path.join(latestBackup, 'tools');
  try {
    await fs.access(backedUpTools);
    await fs.mkdir(config.toolsDir, { recursive: true });
    await copyDir(backedUpTools, config.toolsDir);
  } catch {
    // No tools in backup — that's ok, might have been empty.
  }

  console.log('Restore complete.');
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function isDatabaseHealthy(dbPath: string): Promise<boolean> {
  try {
    await fs.access(dbPath);
  } catch {
    return false; // File doesn't exist.
  }

  // Try opening it and running a quick integrity check.
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const result = db.pragma('integrity_check') as { integrity_check: string }[];
    return result[0]?.integrity_check === 'ok';
  } catch {
    return false; // Can't open or query — corrupt.
  } finally {
    db?.close();
  }
}

async function findLatestBackup(backupDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(backupDir);
  } catch {
    return null;
  }

  const backups = entries
    .filter((e) => e.startsWith('backup_'))
    .sort();

  if (backups.length === 0) return null;

  // Latest is last (sorted chronologically by ISO timestamp).
  const latest = path.join(backupDir, backups[backups.length - 1]);

  // Verify the backup actually has a database file.
  try {
    await fs.access(path.join(latest, 'hiram.db'));
    return latest;
  } catch {
    return null;
  }
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });

  let entries;
  try {
    entries = await fs.readdir(src, { withFileTypes: true });
  } catch {
    // Source doesn't exist yet (no plugins created). That's fine.
    return;
  }

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}
