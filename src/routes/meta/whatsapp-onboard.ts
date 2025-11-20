// src/routes/meta/whatsapp-onboard.ts
import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth"; // 👈 igual que en el resto

const router = Router();

// POST  /api/meta/whatsapp/onboard-complete
// (recuerda: en app.ts ya montas este router con: app.use("/api/meta", whatsappOnboardRouter);)
router.post(
  "/whatsapp/onboard-complete",
  authenticateUser, // el usuario debe estar logueado en tu SaaS
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const tenantId = user?.tenant_id;

      if (!tenantId) {
        return res.status(401).json({ error: "Tenant no encontrado en sesión" });
      }

      // Lo que el frontend nos va a mandar después del Embedded Signup
      const {
        waba_id,
        phone_number_id,
        phone_number,
        access_token,
      } = req.body as {
        waba_id?: string;
        phone_number_id?: string;
        phone_number?: string;
        access_token?: string;
      };

      if (!waba_id && !phone_number_id && !phone_number && !access_token) {
        return res
          .status(400)
          .json({ error: "No llegaron datos de WhatsApp desde el frontend" });
      }

      // 🔐 Guardar en la tabla tenants usando TUS columnas reales:
      //   - whatsapp_business_id
      //   - whatsapp_phone_number_id
      //   - whatsapp_phone_number
      //   - whatsapp_access_token
      //   - whatsapp_connected
      //   - whatsapp_connected_at
      await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_business_id      = COALESCE($1, whatsapp_business_id),
          whatsapp_phone_number_id  = COALESCE($2, whatsapp_phone_number_id),
          whatsapp_phone_number     = COALESCE($3, whatsapp_phone_number),
          whatsapp_access_token     = COALESCE($4, whatsapp_access_token),
          whatsapp_connected        = TRUE,
          whatsapp_connected_at     = NOW(),
          updated_at                = NOW()
        WHERE id = $5
      `,
        [
          waba_id || null,
          phone_number_id || null,
          phone_number || null,
          access_token || null,
          tenantId,
        ]
      );

      console.log("✅ WhatsApp conectado para tenant", tenantId, {
        waba_id,
        phone_number_id,
        phone_number,
      });

      return res.json({ success: true });
    } catch (err) {
      console.error("❌ Error en /whatsapp/onboard-complete:", err);
      return res
        .status(500)
        .json({ error: "Error interno guardando datos de WhatsApp" });
    }
  }
);

export default router;
