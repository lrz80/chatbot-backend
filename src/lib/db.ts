import { Pool } from "pg";
import dotenv from "dotenv";
import * as path from "path";
import fs from "fs";

const envLocalPath = path.resolve(process.cwd(), ".env.local");
const envPath = path.resolve(process.cwd(), ".env");

if (process.env.NODE_ENV !== "production") {
  if (fs.existsSync(envLocalPath)) {
    dotenv.config({ path: envLocalPath });
  } else if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL no está definida");
}

const rawSslMode = String(process.env.PG_SSL_MODE || "").trim().toLowerCase();
const shouldUseSSL =
  rawSslMode === "require" ||
  rawSslMode === "true" ||
  process.env.NODE_ENV === "production" ||
  DATABASE_URL.includes("railway.app") ||
  DATABASE_URL.includes("proxy.rlwy.net");

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 4),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30_000),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS ?? 10_000),
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  ssl: shouldUseSSL ? { rejectUnauthorized: false } : undefined,
  maxUses: Number(process.env.PG_MAX_USES ?? 7500),
  allowExitOnIdle: false,
});

pool.on("error", (err) => {
  console.error("❌ PG pool error:", err);
});

export default pool;