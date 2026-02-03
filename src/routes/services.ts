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
  const client = await pool.connect();
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
      variants, // ✅
    } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "name es requerido" });
    }
    if (!isValidUrl(service_url)) {
      return res.status(400).json({ error: "service_url inválido" });
    }

    const vList = Array.isArray(variants) ? variants : [];

    await client.query("BEGIN");

    const svcRes = await client.query(
      `
      INSERT INTO services (
        tenant_id, category, name, description,
        duration_min, price_base,
        service_url, active
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
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

    const service = svcRes.rows[0];

    const insertedVariants: any[] = [];
    for (const v of vList) {
      const vn = String(v?.variant_name || "").trim();
      if (!vn) continue; // si quieres exigirlo: throw new Error("variant_name requerido");

      const dur = v?.duration_min == null ? null : Number(v.duration_min);
      if (v?.duration_min != null && !Number.isFinite(dur)) throw new Error("variant duration_min inválido");

      const pr = v?.price == null ? null : Number(v.price);
      if (v?.price != null && !Number.isFinite(pr)) throw new Error("variant price inválido");

      const cur = (v?.currency ? String(v.currency).trim().toUpperCase() : "USD") || "USD";

      let url: string | null = null;
      if (v?.variant_url && String(v.variant_url).trim()) {
        if (!isValidUrl(String(v.variant_url))) throw new Error("variant_url inválido");
        url = String(v.variant_url).trim();
      }

      const vr = await client.query(
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
          service.id,
          vn,
          v?.description ? String(v.description) : "",
          dur,
          pr,
          cur,
          url,
          v?.active ?? true,
        ]
      );

      insertedVariants.push(vr.rows[0]);
    }

    await client.query("COMMIT");
    return res.status(201).json({ service: { ...service, variants: insertedVariants } });
    } catch (e: any) {
    try { await client.query("ROLLBACK"); } catch {}

    console.error("POST /api/services error:", e);

    // ✅ DUPLICADO: (tenant_id, category, name)
    if (e?.code === "23505" && e?.constraint === "services_tenant_category_name_uniq") {
        return res.status(409).json({
        error: "Servicio ya existe en esa categoría",
        code: "SERVICE_ALREADY_EXISTS",
        detail: e?.detail,
        });
    }

    // ✅ NOT NULL (duration_min) por si aún te pasa
    if (e?.code === "23502" && e?.column === "duration_min") {
        return res.status(400).json({
        error: "duration_min es requerido (tu DB no permite null).",
        code: "DURATION_REQUIRED",
        detail: e?.detail,
        });
    }

    return res.status(500).json({
        error: "Error creando servicio",
        detail: e?.message,
        code: e?.code,
    });
    } finally {
    client.release();
    }
});

router.put("/:id", authenticateUser, async (req: any, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: "Tenant no encontrado" });

    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id requerido" });

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
      UPDATE services
         SET category = $3,
             name = $4,
             description = $5,
             duration_min = $6,
             price_base = $7,
             service_url = $8,
             active = $9,
             updated_at = NOW()
       WHERE id = $1
         AND tenant_id = $2
       RETURNING *
      `,
      [
        id,
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

    if (!rows[0]) return res.status(404).json({ error: "Servicio no encontrado" });

    return res.json({ service: rows[0] });
  } catch (e: any) {
    console.error("PUT /api/services/:id error:", e);
    return res.status(500).json({ error: "Error actualizando servicio", detail: e?.message });
  }
});

router.patch("/:id", authenticateUser, async (req: any, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: "Tenant no encontrado" });

    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id requerido" });

    // solo permitimos cambiar "active" en PATCH
    const { active } = req.body || {};
    if (typeof active !== "boolean") {
      return res.status(400).json({ error: "active debe ser boolean" });
    }

    const { rows } = await pool.query(
      `
      UPDATE services
         SET active = $3,
             updated_at = NOW()
       WHERE id = $1
         AND tenant_id = $2
       RETURNING *
      `,
      [id, tenantId, active]
    );

    if (!rows[0]) return res.status(404).json({ error: "Servicio no encontrado" });

    return res.json({ service: rows[0] });
  } catch (e: any) {
    console.error("PATCH /api/services/:id error:", e);
    return res.status(500).json({ error: "Error actualizando servicio", detail: e?.message });
  }
});

router.delete("/:id", authenticateUser, async (req: any, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: "Tenant no encontrado" });

    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id requerido" });

    const r = await pool.query(
      `
      DELETE FROM services
       WHERE id = $1
         AND tenant_id = $2
      `,
      [id, tenantId]
    );

    return res.json({ ok: true, deleted: r.rowCount || 0 });
  } catch (e: any) {
    // si hay FK con variantes, aquí puede fallar
    console.error("DELETE /api/services/:id error:", e);
    return res.status(500).json({ error: "Error eliminando servicio", detail: e?.message });
  }
});

// en src/routes/services.ts (o router separado, pero lo pongo aquí)
router.post("/:id/variants", authenticateUser, async (req: any, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: "Tenant no encontrado" });

    const serviceId = String(req.params.id || "").trim();
    if (!serviceId) return res.status(400).json({ error: "service_id requerido" });

    // ✅ validar que el service pertenece al tenant
    const svc = await pool.query(
      `SELECT id FROM services WHERE id = $1 AND tenant_id = $2`,
      [serviceId, tenantId]
    );
    if (!svc.rows[0]) return res.status(404).json({ error: "Servicio no encontrado" });

    const {
      variant_name,
      description,
      duration_min,
      price,
      currency,
      variant_url,
      active,
    } = req.body || {};

    if (!variant_name || !String(variant_name).trim()) {
      return res.status(400).json({ error: "variant_name es requerido" });
    }

    // duration_min puede ser null, price puede ser null
    const dur = duration_min == null ? null : Number(duration_min);
    if (duration_min != null && !Number.isFinite(dur)) {
      return res.status(400).json({ error: "duration_min inválido" });
    }

    const pr = price == null ? null : Number(price);
    if (price != null && !Number.isFinite(pr)) {
      return res.status(400).json({ error: "price inválido" });
    }

    const cur = (currency ? String(currency).trim().toUpperCase() : "USD") || "USD";

    let url: string | null = null;
    if (variant_url && String(variant_url).trim()) {
      if (!isValidUrl(String(variant_url))) return res.status(400).json({ error: "variant_url inválido" });
      url = String(variant_url).trim();
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
        serviceId,
        String(variant_name).trim(),
        description ? String(description) : "",
        dur,
        pr,
        cur,
        url,
        active ?? true,
      ]
    );

    return res.status(201).json({ variant: rows[0] });
  } catch (e: any) {
    console.error("POST /api/services/:id/variants error:", e);
    return res.status(500).json({ error: "Error creando variante", detail: e?.message });
  }
});

router.put("/:id/variants/:variantId", authenticateUser, async (req: any, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: "Tenant no encontrado" });

    const serviceId = String(req.params.id || "").trim();
    const variantId = String(req.params.variantId || "").trim();

    const { variant_name, description, duration_min, price, currency, variant_url, active } = req.body || {};

    if (!variant_name || !String(variant_name).trim()) {
      return res.status(400).json({ error: "variant_name es requerido" });
    }

    const dur = duration_min == null ? null : Number(duration_min);
    if (duration_min != null && !Number.isFinite(dur)) {
      return res.status(400).json({ error: "duration_min inválido" });
    }

    const pr = price == null ? null : Number(price);
    if (price != null && !Number.isFinite(pr)) {
      return res.status(400).json({ error: "price inválido" });
    }

    const cur = (currency ? String(currency).trim().toUpperCase() : "USD") || "USD";

    let url: string | null = null;
    if (variant_url && String(variant_url).trim()) {
      if (!isValidUrl(String(variant_url))) return res.status(400).json({ error: "variant_url inválido" });
      url = String(variant_url).trim();
    }

    const { rows } = await pool.query(
      `
      UPDATE service_variants v
         SET variant_name = $4,
             description = $5,
             duration_min = $6,
             price = $7,
             currency = $8,
             variant_url = $9,
             active = $10,
             updated_at = NOW()
      FROM services s
      WHERE v.id = $1
        AND v.service_id = $2
        AND s.id = v.service_id
        AND s.tenant_id = $3
      RETURNING v.*
      `,
      [
        variantId,
        serviceId,
        tenantId,
        String(variant_name).trim(),
        description ? String(description) : "",
        dur,
        pr,
        cur,
        url,
        active ?? true,
      ]
    );

    if (!rows[0]) return res.status(404).json({ error: "Variante no encontrada" });

    return res.json({ variant: rows[0] });
  } catch (e: any) {
    console.error("PUT /api/services/:id/variants/:variantId error:", e);
    return res.status(500).json({ error: "Error actualizando variante", detail: e?.message });
  }
});

router.delete("/:id/variants/:variantId", authenticateUser, async (req: any, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(401).json({ error: "Tenant no encontrado" });

    const serviceId = String(req.params.id || "").trim();
    const variantId = String(req.params.variantId || "").trim();

    const r = await pool.query(
      `
      DELETE FROM service_variants v
      USING services s
      WHERE v.id = $1
        AND v.service_id = $2
        AND s.id = v.service_id
        AND s.tenant_id = $3
      `,
      [variantId, serviceId, tenantId]
    );

    return res.json({ ok: true, deleted: r.rowCount || 0 });
  } catch (e: any) {
    console.error("DELETE /api/services/:id/variants/:variantId error:", e);
    return res.status(500).json({ error: "Error eliminando variante", detail: e?.message });
  }
});

export default router;
