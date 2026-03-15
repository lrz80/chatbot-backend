// src/lib/db.ts
import { Pool } from "pg";
import dotenv from "dotenv";
import * as path from "path";

if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: path.resolve(__dirname, "../../.env.local") });
}

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL no está definida");
}

const shouldUseSSL = process.env.NODE_ENV === "production";

const pool = new Pool({
  connectionString: DATABASE_URL,

  max: Number(process.env.PG_POOL_MAX ?? 4),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30_000),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS ?? 10_000),

  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,

  ssl: shouldUseSSL ? { rejectUnauthorized: false } : undefined,

  // cierra conexiones “viejas” para evitar sockets raros de larga duración
  maxUses: Number(process.env.PG_MAX_USES ?? 7500),

  // opcional pero útil para no dejar clientes eternos
  allowExitOnIdle: false,
});

pool.on("error", (err) => {
  console.error("❌ PG pool error:", err);
});

export default pool;