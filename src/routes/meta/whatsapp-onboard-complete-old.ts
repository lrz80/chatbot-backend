// src/routes/meta/whatsapp-onboard-complete.ts
import express, { Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth"; // o como se llame tu middleware

const router = express.Router();

/**
 * Endpoint llamado desde RedirectClient.tsx cuando
 * el Embedded Signup devuelve phone_number_id + waba_id
 */
router.post(
  "/whatsapp/onboard-complete",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const { wabaId, phoneNumberId } = req.body;

      const user: any = (req as any).user;
      const tenantId = user?.tenant_id;

      console.log("[WA ONBOARD COMPLETE] Body recibido:", {
        wabaId,
        phoneNumberId,
        tenantId,
      });

      if (!tenantId) {
        return res.status(401).json({ error: "Tenant no identificado" });
      }

      if (!wabaId || !phoneNumberId) {
        return res
          .status(400)
          .json({ error: "Faltan wabaId o phoneNumberId en el cuerpo" });
      }

      const updateQuery = `
        UPDATE tenants
        SET
          whatsapp_business_id      = $1,
          whatsapp_phone_number_id  = $2,
          whatsapp_status           = 'connected',
          whatsapp_connected        = TRUE,
          whatsapp_connected_at     = NOW(),
          updated_at                = NOW()
        WHERE id::text = $3
        RETURNING id,
                  whatsapp_business_id,
                  whatsapp_phone_number_id,
                  whatsapp_status,
                  whatsapp_connected,
                  whatsapp_connected_at;
      `;

      const result = await pool.query(updateQuery, [
        wabaId,
        phoneNumberId,
        tenantId,
      ]);

      console.log(
        "💾 [WA ONBOARD COMPLETE] UPDATE rowCount:",
        result.rowCount,
        "rows:",
        result.rows
      );

      return res.json({ ok: true, tenant: result.rows[0] });
    } catch (err) {
      console.error(
        "❌ [WA ONBOARD COMPLETE] Error guardando datos de WhatsApp:",
        err
      );
      return res
        .status(500)
        .json({ error: "Error interno guardando la conexión" });
    }
  }
);

export default router;
