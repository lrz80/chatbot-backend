// src/routes/meta/whatsapp-onboard-start.ts
import express, { Request, Response } from "express";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();

const APP_ID = process.env.META_APP_ID;
const REDIRECT_URI =
  "https://api.aamy.ai/api/meta/whatsapp/callback"; // debe ser EXACTAMENTE igual al de Facebook Login

/**
 * POST /api/meta/whatsapp-onboard/start
 *
 * Genera la URL de Login OAuth clásica de Facebook
 * para pedir permisos de WhatsApp Business y devuelve esa URL al frontend.
 */
router.post(
  "/start",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const tenantId = user?.tenant_id as string | undefined;

      if (!tenantId) {
        console.error(
          "[WA ONBOARD START] Falta tenant_id en el token del usuario."
        );
        return res.status(401).json({
          error: "No autenticado: falta tenant_id en el token.",
        });
      }

      if (!APP_ID) {
        console.error("[WA ONBOARD START] Falta META_APP_ID en env.");
        return res.status(500).json({
          error: "Configuración del servidor incompleta (META_APP_ID).",
        });
      }

      // Scopes válidos (IMPORTANTE: nada de read_business_management)
      const scopes = [
        "whatsapp_business_messaging",
        "whatsapp_business_management",
        "business_management",
        // opcionales pero útiles:
        "pages_show_list",
        "pages_messaging",
      ].join(",");

      const url =
        "https://www.facebook.com/v18.0/dialog/oauth" +
        `?client_id=${encodeURIComponent(APP_ID)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent(scopes)}` +
        `&state=${encodeURIComponent(tenantId)}`;

      console.log("[WA ONBOARD START] URL OAuth generada:", {
        url,
        tenant_id: tenantId,
        email: user?.email,
      });

      return res.json({ url });
    } catch (err) {
      console.error("[WA ONBOARD START] Error general:", err);
      return res
        .status(500)
        .json({ error: "Error interno iniciando el onboarding de WhatsApp." });
    }
  }
);

export default router;
