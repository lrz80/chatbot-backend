// src/routes/meta/whatsapp-onboard-start.ts

import { Router, Request, Response } from "express";
import { authenticateUser } from "../../middleware/auth";

const router = Router();

/**
 * POST /api/meta/whatsapp-onboard/start
 *
 * Devuelve la URL de Facebook OAuth para iniciar el flujo de conexión,
 * con redirect a /api/meta/whatsapp/callback y state = tenant_id.
 */
router.post("/start", authenticateUser, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const tenantId = user?.tenant_id as string | undefined;

    if (!tenantId) {
      console.error("[WA ONBOARD START] Falta tenant_id en el token");
      return res
        .status(401)
        .json({ error: "No autenticado: falta tenant_id en el token." });
    }

    const APP_ID = process.env.META_APP_ID;
    if (!APP_ID) {
      console.error("[WA ONBOARD START] Falta META_APP_ID en las variables env");
      return res.status(500).json({
        error: "Configuración del servidor incompleta (META_APP_ID).",
      });
    }

    // Debe coincidir EXACTAMENTE con el que pusiste en:
    // App > Facebook Login for Business > Settings > Valid OAuth Redirect URIs
    const REDIRECT_URI = "https://api.aamy.ai/api/meta/whatsapp/callback";

    // Scopes mínimos recomendados para este flujo
    const scopes = [
      "business_management",
      "whatsapp_business_messaging",
      "whatsapp_business_management",
      "read_business_management",
    ];

    const url = new URL("https://www.facebook.com/v18.0/dialog/oauth");
    url.searchParams.set("client_id", APP_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("state", tenantId);
    url.searchParams.set("scope", scopes.join(","));

    console.log("[WA ONBOARD START] URL OAuth:", url.toString());

    return res.json({ url: url.toString() });
  } catch (err) {
    console.error("[WA ONBOARD START] Error general:", err);
    return res
      .status(500)
      .json({ error: "Error interno iniciando el onboarding de WhatsApp." });
  }
});

export default router;
