// src/routes/meta/whatsapp-accounts.ts
import express, { Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();

// Hacemos un tipo “suave” para tener req.user tipado
interface AuthedRequest extends Request {
  user?: {
    uid: string;
    tenant_id: string;
    email?: string;
  };
}

/**
 * POST /api/meta/whatsapp/select-number
 *
 * Guarda en la tabla tenants la WABA y número que el tenant quiere usar.
 */
router.post(
  "/whatsapp/select-number",
  authenticateUser,
  async (req: AuthedRequest, res: Response) => {
    try {
      const tenantId = req.user?.tenant_id;
      if (!tenantId) {
        return res.status(401).json({ error: "No autenticado" });
      }

      const { waba_id, phone_number_id, phone_number } = req.body || {};

      if (!waba_id || !phone_number_id || !phone_number) {
        return res.status(400).json({
          error:
            "Faltan datos. Debes enviar waba_id, phone_number_id y phone_number en el body.",
        });
      }

      const updateQuery = `
        UPDATE tenants
        SET
          whatsapp_business_id      = $1,
          whatsapp_phone_number_id  = $2,
          whatsapp_phone_number     = $3,
          whatsapp_status           = 'connected',
          updated_at                = NOW()
        WHERE id = $4
        RETURNING id, whatsapp_business_id, whatsapp_phone_number_id, whatsapp_phone_number;
      `;

      const { rows } = await pool.query(updateQuery, [
        waba_id,
        phone_number_id,
        phone_number,
        tenantId,
      ]);

      console.log(
        "[WA SELECT] Tenant actualizado con selección manual:",
        rows[0]
      );

      return res.json({ ok: true, tenant: rows[0] });
    } catch (err) {
      console.error("❌ [WA SELECT] Error inesperado:", err);
      return res.status(500).json({
        error: "Error interno al guardar el número seleccionado",
      });
    }
  }
);

export default router;
