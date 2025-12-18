// src/routes/meta/whatsapp-save-token.ts
import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = Router();

/**
 * POST /api/meta/whatsapp/save-token
 * Body: { whatsapp_access_token: string }
 */
router.post(
  "/whatsapp/save-token",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const tenantId =
        (req as any).user?.tenant_id || (req as any).user?.tenantId;

      console.log("🧪 [WA SAVE TOKEN] tenantId:", tenantId);
      console.log("🧪 [WA SAVE TOKEN] req.user:", (req as any).user);

      // Log seguro del body
      console.log("🧪 [WA SAVE TOKEN] body:", {
        keys: Object.keys(req.body || {}),
        hasToken: !!req.body?.whatsapp_access_token,
        tokenPrefix: req.body?.whatsapp_access_token?.slice?.(0, 12),
        tokenLen: req.body?.whatsapp_access_token?.length,
      });

      if (!tenantId) {
        return res.status(401).json({ ok: false, error: "No autenticado" });
      }

      const token = req.body?.whatsapp_access_token as string | undefined;

      if (!token || !token.trim()) {
        return res
          .status(400)
          .json({ ok: false, error: "Falta whatsapp_access_token" });
      }

      console.log("🧪 [WA SAVE TOKEN] updating DB...", { tenantId });

      const r = await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_access_token = $1,
          updated_at = NOW()
        WHERE id::text = $2
        RETURNING id, whatsapp_access_token;
        `,
        [token, tenantId]
      );

      console.log("🧪 [WA SAVE TOKEN] UPDATE result:", {
        rowCount: r.rowCount,
        rows: r.rows,
      });

      // 🔴 Si no actualizó, es que NO matchea el tenantId con tenants.id
      if (!r.rowCount) {
        console.error("❌ [WA SAVE TOKEN] No se actualizó ningún tenant", {
          tenantId,
        });
        return res.status(404).json({
          ok: false,
          error:
            "No se actualizó ningún tenant (tenantId no coincide con tenants.id).",
        });
      }

      // Respuesta con evidencia mínima (sin exponer token completo)
      return res.json({
        ok: true,
        tenantId: r.rows?.[0]?.id,
        saved: true,
        tokenPrefix: String(r.rows?.[0]?.whatsapp_access_token || "").slice(0, 12),
      });
    } catch (err) {
      console.error("❌ [WA SAVE TOKEN] error:", err);
      return res.status(500).json({ ok: false, error: "Error guardando token" });
    }
  }
);

export default router;
