import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  ComputerAudit,
  ComputerFolder,
  ComputerPermissions,
} from '../shared/computer-types.js';
export class ComputerStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS computer_permissions(dotId TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS computer_audit(id TEXT PRIMARY KEY,dotId TEXT NOT NULL,action TEXT NOT NULL,actor TEXT NOT NULL,outcome TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS computer_folders(dotId TEXT NOT NULL,path TEXT NOT NULL,kind TEXT NOT NULL,addedAt INTEGER NOT NULL,PRIMARY KEY(dotId,path));`);
  }
  permissions(id: string): ComputerPermissions {
    const row = this.db
      .prepare('SELECT value FROM computer_permissions WHERE dotId=?')
      .get(id);
    return row
      ? JSON.parse(String(row.value))
      : { enabled: false, browser: false, files: false, shell: false };
  }
  patch(id: string, patch: Partial<ComputerPermissions>) {
    const value = { ...this.permissions(id), ...patch };
    this.db
      .prepare('INSERT OR REPLACE INTO computer_permissions VALUES (?,?)')
      .run(id, JSON.stringify(value));
    return value;
  }
  /** Folders and files from the owner's Mac shared into this Dot's computer. */
  folders(id: string): ComputerFolder[] {
    return this.db
      .prepare(
        'SELECT path,kind,addedAt FROM computer_folders WHERE dotId=? ORDER BY path',
      )
      .all(id) as unknown as ComputerFolder[];
  }
  addFolder(id: string, path: string, kind: ComputerFolder['kind']) {
    this.db
      .prepare('INSERT OR IGNORE INTO computer_folders VALUES (?,?,?,?)')
      .run(id, path, kind, Date.now());
  }
  removeFolder(id: string, path: string) {
    return (
      Number(
        this.db
          .prepare('DELETE FROM computer_folders WHERE dotId=? AND path=?')
          .run(id, path).changes,
      ) > 0
    );
  }
  begin(dotId: string, action: string, actor: 'owner' | 'agent') {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO computer_audit VALUES (?,?,?,?,?,?)')
      .run(id, dotId, action, actor, 'pending', Date.now());
    return id;
  }
  finish(id: string, outcome: 'succeeded' | 'failed') {
    this.db
      .prepare('UPDATE computer_audit SET outcome=? WHERE id=?')
      .run(outcome, id);
    this.db
      .prepare(
        `DELETE FROM computer_audit WHERE dotId=(SELECT dotId FROM computer_audit WHERE id=?) AND outcome!='pending' AND id NOT IN (SELECT id FROM computer_audit WHERE dotId=(SELECT dotId FROM computer_audit WHERE id=?) AND outcome!='pending' ORDER BY createdAt DESC,rowid DESC LIMIT 1000)`,
      )
      .run(id, id);
  }
  audit(id: string): ComputerAudit[] {
    return this.db
      .prepare(
        'SELECT id,action,actor,outcome,createdAt FROM computer_audit WHERE dotId=? ORDER BY createdAt DESC LIMIT 50',
      )
      .all(id) as unknown as ComputerAudit[];
  }
}
