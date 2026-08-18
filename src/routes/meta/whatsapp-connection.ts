//src/routes/meta/whatsapp-connection.ts
import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = Router();

router.delete(
  "/whatsapp/connection",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;

      const tenantId: string | undefined =
        user?.tenant_id || user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          ok: false,
          error: "No autenticado: falta tenant_id.",
        });
      }

      const result = await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_business_id       = NULL,
          whatsapp_phone_number_id   = NULL,
          whatsapp_phone_number      = NULL,
          whatsapp_access_token      = NULL,
          whatsapp_sender_sid        = NULL,
          whatsapp_status            = 'disconnected',
          whatsapp_connected         = FALSE,
          whatsapp_connected_at      = NULL,
          updated_at                 = NOW()
        WHERE id::text = $1
        RETURNING
          id,
          whatsapp_mode,
          whatsapp_status,
          whatsapp_connected
        `,
        [tenantId]
      );

      if (!result.rowCount) {
        return res.status(404).json({
          ok: false,
          error: "Tenant no encontrado.",
        });
      }

      console.log("[WA META DISCONNECT] WhatsApp desconectado de Aamy:", {
        tenantId,
      });

      return res.json({
        ok: true,
        status: "disconnected",
        tenant: result.rows[0],
      });
    } catch (err) {
      console.error(
        "[WA META DISCONNECT] Error al desconectar WhatsApp:",
        err
      );

      return res.status(500).json({
        ok: false,
        error: "Error al desconectar la cuenta de WhatsApp.",
      });
    }
  }
);

export default router;