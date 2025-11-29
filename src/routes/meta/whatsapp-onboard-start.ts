// src/routes/meta/whatsapp-onboard-start.ts
import express, { Request, Response } from "express";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();

/**
 * POST /api/meta/whatsapp-onboard/start
 *
 * Genera la URL de Embedded Signup (Meta-hosted)
 * para que el frontend la abra en un popup.
 *
 * Esta ruta se monta en index.ts con:
 * router.use("/whatsapp-onboard", whatsappOnboardStartRouter);
 * por lo que la URL final es:
 *   POST /api/meta/whatsapp-onboard/start
 */
router.post(
  "/start",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const APP_ID = process.env.META_APP_ID;
      const CONFIG_ID = process.env.META_EMBEDDED_SIGNUP_CONFIG_ID;

      if (!APP_ID || !CONFIG_ID) {
        console.error(
          "[WA ONBOARD START] Falta META_APP_ID o META_EMBEDDED_SIGNUP_CONFIG_ID"
        );
        return res.status(500).json({
          error: "Falta configuración de Meta (APP_ID o CONFIG_ID)",
        });
      }

      const user = (req as any).user;
      const tenantId = user?.tenant_id as string | undefined;

      if (!tenantId) {
        console.warn("[WA ONBOARD START] No se recibió tenantId (req.user vacío)");
        return res
          .status(401)
          .json({ error: "No autenticado: falta tenant_id en el token." });
      }

      // ✅ URL correcta de Embedded Signup (Meta-hosted)
      const url = new URL(
        "https://business.facebook.com/messaging/whatsapp/onboard/"
      );
      url.searchParams.set("app_id", APP_ID);
      url.searchParams.set("config_id", CONFIG_ID);
      url.searchParams.set("state", tenantId);

      console.log("[WA ONBOARD START] URL Embedded Signup:", url.toString());

      return res.json({ url: url.toString() });
    } catch (err) {
      console.error("❌ [WA ONBOARD START] Error inesperado:", err);
      return res
        .status(500)
        .json({ error: "No se pudo iniciar el onboarding de WhatsApp" });
    }
  }
);

export default router;
