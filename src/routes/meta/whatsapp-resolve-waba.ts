import express, { Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();

/**
 * GET /api/meta/whatsapp/resolve-waba
 *
 * Usa el whatsapp_access_token del tenant para:
 * 1) listar businesses del usuario
 * 2) buscar owned_whatsapp_business_accounts
 * 3) guardar whatsapp_business_id (WABA) y whatsapp_business_manager_id (Business)
 */
router.get(
  "/whatsapp/resolve-waba",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const tenantId =
        (req as any).user?.tenant_id || (req as any).user?.tenantId;

      console.log("🧪 [WA RESOLVE WABA] tenantId:", tenantId);

      if (!tenantId) {
        return res.status(401).json({ ok: false, error: "No autenticado" });
      }

      // 1) Leer token del tenant
      const t = await pool.query(
        `
        SELECT whatsapp_access_token
        FROM tenants
        WHERE id::text = $1
        LIMIT 1
        `,
        [tenantId]
      );

      const accessToken: string | null = t.rows?.[0]?.whatsapp_access_token || null;

      console.log("🧪 [WA RESOLVE WABA] hasToken:", !!accessToken);

      if (!accessToken) {
        return res.json({ ok: false, status: "no_token", businesses: [] });
      }

      // 2) Pedir businesses del usuario + WABAs owned por business
      const url =
        "https://graph.facebook.com/v18.0/me/businesses" +
        "?fields=id,name,owned_whatsapp_business_accounts{id,name}" +
        `&access_token=${encodeURIComponent(accessToken)}`;

      console.log("🧪 [WA RESOLVE WABA] GET:", url);

      const r = await fetch(url);
      const j: any = await r.json();

      console.log("🧪 [WA RESOLVE WABA] response:", r.status, JSON.stringify(j, null, 2));

      if (!r.ok) {
        return res.status(500).json({
          ok: false,
          error: "Graph error en /me/businesses",
          detail: j,
        });
      }

      const businesses = Array.isArray(j?.data) ? j.data : [];

      // 3) Encontrar el PRIMER WABA disponible
      // (si quieres, luego lo hacemos seleccionable en UI)
      let pickedBusinessId: string | null = null;
      let pickedWabaId: string | null = null;

      for (const b of businesses) {
        const wabas = b?.owned_whatsapp_business_accounts?.data || [];
        if (Array.isArray(wabas) && wabas.length > 0) {
          pickedBusinessId = String(b.id);
          pickedWabaId = String(wabas[0].id);
          break;
        }
      }

      console.log("🧪 [WA RESOLVE WABA] picked:", { pickedBusinessId, pickedWabaId });

      if (!pickedWabaId) {
        return res.json({
          ok: false,
          status: "no_waba_found",
          businesses,
        });
      }

      // 4) Guardar en DB: business_manager_id + waba_id
      const u = await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_business_manager_id = $1,
          whatsapp_business_id = $2,
          updated_at = NOW()
        WHERE id::text = $3
        RETURNING id, whatsapp_business_manager_id, whatsapp_business_id;
        `,
        [pickedBusinessId, pickedWabaId, tenantId]
      );

      console.log("🧪 [WA RESOLVE WABA] saved:", u.rows?.[0]);

      return res.json({
        ok: true,
        status: "saved",
        picked: { businessManagerId: pickedBusinessId, wabaId: pickedWabaId },
        businesses,
      });
    } catch (err) {
      console.error("❌ [WA RESOLVE WABA] error:", err);
      return res.status(500).json({ ok: false, error: "Error resolviendo WABA" });
    }
  }
);

export default router;
