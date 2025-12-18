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
      console.log("🧪 [WA SAVE TOKEN] req.body keys:", Object.keys(req.body || {}));

      if (!tenantId) {
        return res.status(401).json({ ok: false, error: "No autenticado" });
      }

      const token = req.body?.whatsapp_access_token as string | undefined;

      console.log("🧪 [WA SAVE TOKEN] token exists:", !!token);
      console.log("🧪 [WA SAVE TOKEN] tokenPrefix:", token?.slice?.(0, 10));

      if (!token || !token.trim()) {
        return res.status(400).json({ ok: false, error: "Falta whatsapp_access_token" });
      }

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

      console.log("🧪 [WA SAVE TOKEN] update rowCount:", r.rowCount);

      return res.json({ ok: true });
    } catch (err) {
      console.error("❌ [WA SAVE TOKEN] error:", err);
      return res.status(500).json({ ok: false, error: "Error guardando token" });
    }
  }
);

export default router;
