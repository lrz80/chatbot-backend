import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import auth from "../auth"; // ajusta la ruta a tu middleware real

const router = Router();

// POST /api/meta/whatsapp/onboard-complete
router.post(
  "/whatsapp/onboard-complete",
  auth, // el usuario debe estar logueado
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user; // según tu tipo real
      const tenantId = user?.tenant_id;

      if (!tenantId) {
        return res.status(401).json({ error: "Tenant no encontrado en sesión" });
      }

      const { code, waba_id, phone_number_id } = req.body as {
        code?: string;
        waba_id?: string;
        phone_number_id?: string;
      };

      if (!code && !waba_id && !phone_number_id) {
        return res
          .status(400)
          .json({ error: "No llegaron datos de WhatsApp desde el frontend" });
      }

      // Guardar en la tabla tenants (ajusta nombres de columnas si son otros)
      await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_waba_id = COALESCE($1, whatsapp_waba_id),
          whatsapp_phone_number_id = COALESCE($2, whatsapp_phone_number_id),
          whatsapp_onboard_code = COALESCE($3, whatsapp_onboard_code),
          whatsapp_connected = TRUE,
          updated_at = NOW()
        WHERE id = $4
      `,
        [waba_id || null, phone_number_id || null, code || null, tenantId]
      );

      return res.json({ success: true });
    } catch (err) {
      console.error("Error en /whatsapp/onboard-complete:", err);
      return res
        .status(500)
        .json({ error: "Error interno guardando datos de WhatsApp" });
    }
  }
);

export default router;
