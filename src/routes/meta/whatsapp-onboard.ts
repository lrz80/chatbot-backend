// src/routes/meta/whatsapp-onboard.ts
import express, { Request, Response } from "express";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();

/**
 * POST /api/meta/whatsapp-onboard/start
 * Genera el URL de autorización de Meta (OAuth 2.0) y lo envía al frontend.
 * El frontend lo abre en nueva ventana.
 */
router.post(
  "/whatsapp-onboard/start",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.user?.tenant_id;
      if (!tenantId) {
        return res.status(400).json({ error: "No tenant_id disponible" });
      }

      // Datos desde entorno
      const META_APP_ID = process.env.META_APP_ID;
      const REDIRECT_URI =
        "https://api.aamy.ai/api/meta/whatsapp/callback"; // donde Meta regresará después del login

      if (!META_APP_ID) {
        return res
          .status(500)
          .json({ error: "Falta META_APP_ID en variables de entorno" });
      }

      // URL oficial de inicio de sesión (OAuth Meta)
      const authUrl = `https://www.facebook.com/v18.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(
        REDIRECT_URI
      )}&state=${tenantId}&scope=whatsapp_business_management,whatsapp_business_messaging,pages_show_list`;

      console.log("🌐 URL de Meta generada:", authUrl);

      return res.json({
        ok: true,
        url: authUrl, // frontend abrirá esta ventana
      });
    } catch (err) {
      console.error("❌ Error generando URL de Meta:", err);
      return res
        .status(500)
        .json({ ok: false, error: "Error generando URL de Meta" });
    }
  }
);

export default router;
