import express, { Request, Response } from "express";
import pool from "../lib/db";
import { authenticateUser } from "../middleware/auth";

const router = express.Router();

function isValidUrl(u?: string) {
  if (!u) return true;
  return /^https?:\/\/.+/i.test(u.trim());
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

    const { rows } = await pool.query(
      `
      INSERT INTO service_variants (
        service_id, variant_name, description,
        duration_min, price, currency,
        variant_url, active
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
      `,
      [
        service_id,
        String(variant_name).trim(),
        description || "",
        duration_min ?? null,
        price ?? null,
        currency || "USD",
        variant_url ? String(variant_url).trim() : null,
        active ?? true,
      ]
    );

    return res.status(201).json({ variant: rows[0] });
  } catch (e: any) {
    console.error("POST /api/service-variants error:", e);
    return res.status(500).json({ error: "Error creando variante" });
  }
});

export default router;
