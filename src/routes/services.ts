import express, { Request, Response } from "express";
import pool from "../lib/db";
import { authenticateUser } from "../middleware/auth";

const router = express.Router();

function getTenantId(req: any) {
  return req.user?.tenant_id || req.tenant_id || req.tenantId;
}

function isValidUrl(u?: string) {
  if (!u) return true;
  return /^https?:\/\/.+/i.test(u.trim());
}

/**
 * GET /api/services
 * Lista servicios del tenant (incluye variantes)
 */
router.get("/", authenticateUser, async (req: any, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: "Tenant no encontrado" });

    const { rows: services } = await pool.query(
      `
      SELECT *
      FROM services
      WHERE tenant_id = $1
      ORDER BY category ASC, name ASC
      `,
      [tenantId]
    );

    const serviceIds = services.map((s: any) => s.id);

    let variantsByService: Record<string, any[]> = {};
    if (serviceIds.length) {
      const { rows: variants } = await pool.query(
        `
        SELECT *
        FROM service_variants
        WHERE service_id = ANY($1::uuid[])
        ORDER BY variant_name ASC
        `,
        [serviceIds]
      );

      for (const v of variants) {
        variantsByService[v.service_id] ||= [];
        variantsByService[v.service_id].push(v);
      }
    }

    const out = services.map((s: any) => ({
      ...s,
      variants: variantsByService[s.id] || [],
    }));

    return res.json({ services: out });
  } catch (e: any) {
    console.error("GET /api/services error:", e);
    return res.status(500).json({ error: "Error obteniendo servicios" });
  }
});

/**
 * GET /api/services/search?q=...&limit=5
 * Busca servicios por similitud (pg_trgm) y devuelve coincidencias con variantes.
 */
router.get("/search", authenticateUser, async (req: any, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: "Tenant no encontrado" });

    const q = String(req.query.q || "").trim();
    const limit = Math.min(Number(req.query.limit || 5), 10);

    if (!q) return res.json({ services: [] });

    // 1) Buscar servicios por similitud en name/description
    const { rows: services } = await pool.query(
      `
      SELECT s.*,
             GREATEST(
               similarity(s.name, $2),
               similarity(s.description, $2)
             ) AS score
      FROM services s
      WHERE s.tenant_id = $1
        AND s.active = TRUE
        AND (
          s.name % $2 OR
          s.description % $2
        )
      ORDER BY score DESC, s.category ASC, s.name ASC
      LIMIT $3
      `,
      [tenantId, q, limit]
    );

    const serviceIds = services.map((s: any) => s.id);

    // 2) Traer variantes de esos servicios
    let variantsByService: Record<string, any[]> = {};
    if (serviceIds.length) {
      const { rows: variants } = await pool.query(
        `
        SELECT *
        FROM service_variants
        WHERE service_id = ANY($1::uuid[])
          AND active = TRUE
        ORDER BY variant_name ASC
        `,
        [serviceIds]
      );

      for (const v of variants) {
        variantsByService[v.service_id] ||= [];
        variantsByService[v.service_id].push(v);
      }
    }

    const out = services.map((s: any) => ({
      ...s,
      variants: variantsByService[s.id] || [],
    }));

    return res.json({ services: out });
  } catch (e: any) {
    console.error("GET /api/services/search error:", e);
    return res.status(500).json({ error: "Error buscando servicios" });
  }
});

/**
 * POST /api/services
 * Crea un servicio base (sin variantes)
 */
router.post("/", authenticateUser, async (req: any, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: "Tenant no encontrado" });

    const {
      category,
      name,
      description,
      duration_min,
      price_base,
      service_url,
      active,
    } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "name es requerido" });
    }
    if (!isValidUrl(service_url)) {
      return res.status(400).json({ error: "service_url inválido" });
    }

    const { rows } = await pool.query(
      `
      INSERT INTO services (
        tenant_id, category, name, description,
        duration_min, price_base,
        service_url, active
      )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `,
      [
        tenantId,
        category || "General",
        String(name).trim(),
        description || "",
        duration_min ?? null,
        price_base ?? null,
        service_url ? String(service_url).trim() : null,
        active ?? true,
      ]
    );

    return res.status(201).json({ service: rows[0] });
  } catch (e: any) {
    console.error("POST /api/services error:", e);
    return res.status(500).json({
      error: "Error creando servicio",
      detail: e?.message,
      code: e?.code,
    });
  }
});

export default router;
