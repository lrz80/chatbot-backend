import { Router, Response } from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = Router();

// Memoria (CSV pequeños/medianos). Si luego subes miles, lo pasamos a stream.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
});

function toInt(v: any): number | null {
  const n = Number(String(v ?? "").trim());
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function toFloat(v: any): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n;
}

function toBool(v: any, def = true): boolean {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return def;
  if (["true", "1", "yes", "y", "si", "sí"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return def;
}

// Acepta headers con variaciones comunes
function pick(row: any, keys: string[]): any {
  for (const k of keys) {
    if (row[k] !== undefined) return row[k];
    // soporta variantes con espacios
    const alt = Object.keys(row).find((x) => x.trim().toLowerCase() === k.trim().toLowerCase());
    if (alt) return row[alt];
  }
  return undefined;
}

router.post(
  "/import-csv",
  authenticateUser,
  upload.single("file"),
  async (req: any, res: Response) => {
    try {
      const tenantId = req.user?.tenant_id;
      if (!tenantId) return res.status(401).json({ error: "Tenant no encontrado" });

      const file = req.file;
      if (!file?.buffer) return res.status(400).json({ error: "CSV requerido (field: file)" });

      const csvText = file.buffer.toString("utf8");

      const records: any[] = parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        bom: true,
        trim: true,
      });

      if (!records.length) {
        return res.json({ ok: true, inserted: 0, updated: 0, skipped: 0, errors: [] });
      }

      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      const errors: Array<{ row: number; error: string }> = [];

      // Transacción para consistencia
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        for (let i = 0; i < records.length; i++) {
          const row = records[i];

          const name = String(pick(row, ["name", "service", "service_name"]) ?? "").trim();
          const category = String(pick(row, ["category", "cat"]) ?? "").trim() || "General";
          const description = String(pick(row, ["description", "desc", "details"]) ?? "").trim() || null;

          const durationMin = toInt(pick(row, ["duration_min", "duration", "minutes", "mins"]));
          const priceBase = toFloat(pick(row, ["price_base", "price", "price_from", "from"]));
          const active = toBool(pick(row, ["active", "enabled"]), true);

          const serviceUrl = String(pick(row, ["service_url", "url", "link"]) ?? "").trim() || null;

          if (!name) {
            skipped++;
            errors.push({ row: i + 2, error: "Falta 'name' (nombre del servicio)" }); // +2 por header + 1-index
            continue;
          }

          // UPSERT por (tenant_id, category, name) usando tu unique index
          const q = await client.query(
            `
            INSERT INTO services (
              tenant_id, name, description, category,
              duration_min, price_base, active, service_url,
              created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
            ON CONFLICT (tenant_id, category, name)
            DO UPDATE SET
              description  = COALESCE(EXCLUDED.description, services.description),
              duration_min = COALESCE(EXCLUDED.duration_min, services.duration_min),
              price_base   = COALESCE(EXCLUDED.price_base, services.price_base),
              active       = EXCLUDED.active,
              service_url  = COALESCE(EXCLUDED.service_url, services.service_url),
              updated_at   = NOW()
            RETURNING (xmax = 0) AS inserted;
            `,
            [
              tenantId,
              name,
              description,
              category,
              durationMin,
              priceBase,
              active,
              serviceUrl,
            ]
          );

          const wasInserted = q.rows?.[0]?.inserted === true;
          if (wasInserted) inserted++;
          else updated++;
        }

        await client.query("COMMIT");
      } catch (e: any) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }

      return res.json({ ok: true, inserted, updated, skipped, errors });
    } catch (e: any) {
      console.error("❌ import-csv error:", e?.message);
      return res.status(500).json({ error: "Import failed", detail: e?.message });
    }
  }
);

export default router;
