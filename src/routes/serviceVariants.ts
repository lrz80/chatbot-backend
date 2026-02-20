//src/routes/serviceVariants.ts
import express, { Request, Response } from "express";
import pool from "../lib/db";
import { authenticateUser } from "../middleware/auth";

const router = express.Router();

function isValidUrl(u?: string) {
  if (!u) return true;
  return /^https?:\/\/.+/i.test(u.trim());
}

function parseNullableInt(v: any): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function parseNullableNumber(v: any): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n;
}

function parseNullablePrice(v: any): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;                // ✅ "" => null
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;   // ✅ 2 decimales
}

function parseBool(v: any, fallback: boolean): boolean {
  if (v === true || v === false) return v;
  const s = String(v ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "si"].includes(s)) return true;
  if (["false", "0", "no"].includes(s)) return false;
  return fallback;
}

function parseSizeToken(v: any): "small" | "medium" | "large" | "xl" | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;

  const allowed = new Set(["small", "medium", "large", "xl"]);
  if (!allowed.has(s)) return null; // invalid -> null (o puedes tirar 400)
  return s as any;
}

/**
 * POST /api/service-variants
 * Crea variante para un servicio
 */
router.post("/", authenticateUser, async (req: any, res: Response) => {
  try {
    const {
      service_id,
      variant_name,
      description,
      duration_min,
      price,
      currency,
      variant_url,
      active,
    } = req.body || {};

    if (!service_id) {
      return res.status(400).json({ error: "service_id es requerido" });
    }
    if (!variant_name || !String(variant_name).trim()) {
      return res.status(400).json({ error: "variant_name es requerido" });
    }
    if (!isValidUrl(variant_url)) {
      return res.status(400).json({ error: "variant_url inválido" });
    }

    // Validamos que el service pertenezca al tenant actual (opcional pero seguro)
    const { rows: svcRows } = await pool.query(
      `SELECT tenant_id FROM services WHERE id = $1`,
      [service_id]
    );
    if (!svcRows.length) {
      return res.status(404).json({ error: "Servicio no encontrado" });
    }
    const tenantId = req.user?.tenant_id;
    if (tenantId !== svcRows[0].tenant_id) {
      return res.status(403).json({ error: "No autorizado para este servicio" });
    }

    const durationParsed = parseNullableInt(duration_min);
    const priceParsed = parseNullablePrice(price);
    const currencyParsed = String(currency || "USD").trim().toUpperCase() || "USD";
    const activeParsed = parseBool(active, true);

    const desc = (description === null || description === undefined)
      ? null
      : String(description).trim();

    const url = variant_url ? String(variant_url).trim() : null;

    console.log("[service-variants:create] incoming", {
      service_id,
      variant_name,
      duration_raw: duration_min,
      durationParsed,
      price_raw: price,
      priceParsed,
      currencyParsed,
      url,
      activeParsed,
    });

    const { rows } = await pool.query(
      `
      INSERT INTO service_variants (
        service_id, variant_name, description,
        duration_min, price, currency,
        variant_url, active, created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW(), NOW())
      RETURNING *
      `,
      [
        service_id,
        String(variant_name).trim(),
        desc,                 // ✅ null o string
        durationParsed,       // ✅ int|null
        priceParsed,          // ✅ number|null (nunca "")
        currencyParsed,       // ✅ USD
        url,                  // ✅ null o URL
        activeParsed,         // ✅ boolean
      ]
    );

    console.log("[service-variants:create] saved", {
      id: rows[0]?.id,
      price: rows[0]?.price,
      currency: rows[0]?.currency,
      duration_min: rows[0]?.duration_min,
    });

    return res.status(201).json({ variant: rows[0] });
  } catch (e: any) {
    console.error("POST /api/service-variants error:", e);
    return res.status(500).json({ error: "Error creando variante" });
  }
});

/**
 * PATCH /api/service-variants/:id
 * Actualiza metadata de variante: size_token / min_weight_lbs / max_weight_lbs
 *
 * ✅ EXACTAMENTE para que Brain B (Catalog Resolver) pueda resolver por tamaño/peso.
 */
router.patch("/:id", authenticateUser, async (req: any, res: Response) => {
  try {
    const variantId = String(req.params.id || "").trim();
    if (!variantId) {
      return res.status(400).json({ error: "id de variante requerido" });
    }

    const tenantId = req.user?.tenant_id;
    if (!tenantId) {
      return res.status(401).json({ error: "No autorizado" });
    }

    const {
      size_token,
      min_weight_lbs,
      max_weight_lbs,
    } = req.body || {};

    // 1) validar payload
    const sizeTokenParsed = parseSizeToken(size_token);

    // pesos pueden ser decimales (lbs)
    const minW = parseNullableNumber(min_weight_lbs);
    const maxW = parseNullableNumber(max_weight_lbs);

    if (minW !== null && minW < 0) return res.status(400).json({ error: "min_weight_lbs inválido" });
    if (maxW !== null && maxW < 0) return res.status(400).json({ error: "max_weight_lbs inválido" });
    if (minW !== null && maxW !== null && minW > maxW) {
      return res.status(400).json({ error: "min_weight_lbs no puede ser mayor que max_weight_lbs" });
    }

    // 2) seguridad: validar que esa variante pertenece al tenant actual (join services)
    const { rows: check } = await pool.query(
      `
      SELECT v.id
      FROM service_variants v
      JOIN services s ON s.id = v.service_id
      WHERE v.id = $1 AND s.tenant_id = $2
      LIMIT 1
      `,
      [variantId, tenantId]
    );

    if (!check.length) {
      return res.status(404).json({ error: "Variante no encontrada" });
    }

    // 3) update
    const { rows } = await pool.query(
      `
      UPDATE service_variants
      SET
        size_token = $1,
        min_weight_lbs = $2,
        max_weight_lbs = $3,
        updated_at = NOW()
      WHERE id = $4
      RETURNING id, service_id, variant_name, size_token, min_weight_lbs, max_weight_lbs, updated_at
      `,
      [sizeTokenParsed, minW, maxW, variantId]
    );

    return res.json({ variant: rows[0] });
  } catch (e: any) {
    console.error("PATCH /api/service-variants/:id error:", e);
    return res.status(500).json({ error: "Error actualizando variante" });
  }
});

export default router;
