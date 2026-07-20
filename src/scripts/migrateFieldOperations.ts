// src/scripts/migrateFieldOperations.ts

import fs from "node:fs/promises";
import path from "node:path";
import pool from "../lib/db";

async function migrateFieldOperations(): Promise<void> {
  const migrationPath = path.resolve(
    process.cwd(),
    "src",
    "modules",
    "field-operations",
    "migrations",
    "001_create_field_operations.sql"
  );

  const sql = await fs.readFile(migrationPath, "utf8");

  if (!sql.trim()) {
    throw new Error("FIELD_OPERATIONS_MIGRATION_FILE_EMPTY");
  }

  console.log("[FIELD_OPERATIONS][MIGRATION_START]", {
    migrationPath,
  });

  await pool.query(sql);

  console.log("[FIELD_OPERATIONS][MIGRATION_COMPLETE]");
}

migrateFieldOperations()
  .catch((error: unknown) => {
    console.error("[FIELD_OPERATIONS][MIGRATION_FAILED]", {
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
            }
          : error,
    });

    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });