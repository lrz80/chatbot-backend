// src/lib/db.ts
import { Pool } from "pg";
import dotenv from "dotenv";
import * as path from "path";

if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: path.resolve(__dirname, "../../.env.local") });
}

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  // Falla rápido: evita que la app “arranque” medio rota y luego explote con resets
  throw new Error("DATABASE_URL no está definida");
}

// Railway/managed Postgres: SSL suele ser requerido.
// En local normalmente NO quieres SSL.
const shouldUseSSL = process.env.NODE_ENV === "production";

const pool = new Pool({
  connectionString: DATABASE_URL,

  // ✅ Pool conservador para evitar demasiadas conexiones concurrentes
  // Ajusta si tienes varias instancias o alta concurrencia.
  max: Number(process.env.PG_POOL_MAX ?? 10),

  // ✅ Timeouts razonables para evitar conexiones colgadas
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30_000),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS ?? 10_000),

  ssl: shouldUseSSL ? { rejectUnauthorized: false } : undefined,
});

// ✅ Visibilidad de errores del pool (muy útil con “reset by peer”)
pool.on("error", (err) => {
  console.error("❌ PG pool error:", err);
});

export default pool;
