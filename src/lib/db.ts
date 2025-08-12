// src/lib/db.ts
import { Pool } from "pg";
import dotenv from "dotenv";
import * as path from "path";

if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });
}

console.log("🔐 DATABASE_URL en db.ts: cargada correctamente");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

export default pool;
