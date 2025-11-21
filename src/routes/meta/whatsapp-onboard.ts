// src/routes/meta/whatsapp-onboard.ts
import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = Router();

// POST  /api/meta/whatsapp/onboard-complete
router.post(
  "/whatsapp/onboard-complete",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const tenantId = user?.tenant_id;

      if (!tenantId) {
        return res.status(401).json({ error: "Tenant no encontrado en sesión" });
      }

      // Datos que vienen desde el frontend (RedirectClient)
      const {
        waWabaId,
        waPhoneNumberId,
        businessId,       // Puedes guardarlo después si lo deseas
        phoneNumber,      // Si lo deseas guardar luego
        accessToken       // Si usas API Cloud, lo usamos luego
      } = req.body;

      console.log("📥 Datos recibidos desde frontend:", {
        waWabaId,
        waPhoneNumberId,
        businessId,
        tenantId,
      });

      if (!waWabaId || !waPhoneNumberId) {
        return res.status(400).json({
          error: "Faltan datos de WhatsApp. Se requieren waWabaId y waPhoneNumberId.",
        });
      }

      // Guardamos los datos en las columnas reales de tu DB
      await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_business_id      = $1,
          whatsapp_phone_number_id  = $2,
          whatsapp_status           = 'connected',
          whatsapp_connected        = TRUE,
          whatsapp_connected_at     = NOW(),
          updated_at               = NOW()
        WHERE id = $3
      `,
        [waWabaId, waPhoneNumberId, tenantId]
      );

      console.log("✅ WhatsApp conectado correctamente para tenant", tenantId);

      return res.json({ success: true });
    } catch (err) {
      console.error("❌ Error en /whatsapp/onboard-complete:", err);
      return res.status(500).json({ error: "Error interno guardando datos de WhatsApp" });
    }
  }
);

export default router;
