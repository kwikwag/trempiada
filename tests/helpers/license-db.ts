import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

/**
 * Spin up a temporary SQLite license database with one vehicle entry.
 * Returns the path and a cleanup function to delete the temp directory.
 */
export function createTempLicenseDb(
  plateNo: number,
  make: string,
  model: string,
  color: string,
  year: number,
  seats: number,
): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "trempbot-test-"));
  const dbPath = join(dir, "licenses.db");
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE make_names  (make_id  INTEGER PRIMARY KEY, make_name  TEXT NOT NULL UNIQUE);
    CREATE TABLE model_names (model_id INTEGER PRIMARY KEY, model_name TEXT NOT NULL UNIQUE);
    CREATE TABLE color_names (color_id INTEGER PRIMARY KEY, color_name TEXT NOT NULL UNIQUE);
    CREATE TABLE licenses (
      license_plate_no INTEGER PRIMARY KEY,
      make_id  INTEGER NOT NULL,
      model_id INTEGER NOT NULL,
      color_id INTEGER NOT NULL,
      year     INTEGER NOT NULL,
      seats    INTEGER NOT NULL,
      FOREIGN KEY (make_id)  REFERENCES make_names(make_id),
      FOREIGN KEY (model_id) REFERENCES model_names(model_id),
      FOREIGN KEY (color_id) REFERENCES color_names(color_id)
    ) WITHOUT ROWID;
    INSERT INTO make_names  VALUES (1, '${make}');
    INSERT INTO model_names VALUES (1, '${model}');
    INSERT INTO color_names VALUES (1, '${color}');
    INSERT INTO licenses    VALUES (${plateNo}, 1, 1, 1, ${year}, ${seats});
  `);

  db.close();
  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
