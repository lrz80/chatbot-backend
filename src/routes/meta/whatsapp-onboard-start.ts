// src/routes/meta/whatsapp-onboard-start.ts
import express, { Request, Response } from "express";

const router = express.Router();

/**
 * POST /api/meta/whatsapp-onboard/start
 *
 * Genera la URL de OAuth de Meta para conectar WhatsApp Cloud.
 * El frontend abre esta URL en un popup.
 */
router.post("/", async (req: Request, res: Response) => {   // <-- SOLO "/"
  try {
    const APP_ID = process.env.META_APP_ID;
    const BACKEND_PUBLIC_URL =
      process.env.BACKEND_PUBLIC_URL || "https://api.aamy.ai";

    if (!APP_ID) {
      console.error("[WA ONBOARD START] Falta META_APP_ID en env");
      return res
        .status(500)
        .json({ error: "Falta configuración META_APP_ID en el servidor" });
    }

    // tenantId viene del body o del token (según tu auth)
    const tenantIdFromBody = (req.body?.tenantId as string | undefined)?.trim();
    const tenantId =
      tenantIdFromBody ||
      // @ts-ignore si usas middleware de auth con req.user
      (req.user?.tenant_id as string | undefined);

    if (!tenantId) {
      console.warn("[WA ONBOARD START] No se recibió tenantId");
      return res
        .status(400)
        .json({ error: "Falta tenantId para iniciar el onboarding" });
    }

    const redirectUri = `${BACKEND_PUBLIC_URL}/api/meta/whatsapp/callback`;

    // 👇 Aquí añadimos business_management
    const scopes = [
      "whatsapp_business_management",
      "whatsapp_business_messaging",
      "pages_show_list",
      "business_management",
    ].join(",");

    const url = new URL("https://www.facebook.com/v18.0/dialog/oauth");
    url.searchParams.set("client_id", APP_ID);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", tenantId); // importantísimo: multi-tenant
    url.searchParams.set("scope", scopes);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("display", "popup");

    console.log("🌐 URL de Meta generada:", url.toString());

    return res.json({ url: url.toString() });
  } catch (err) {
    console.error("❌ [WA ONBOARD START] Error inesperado:", err);
    return res
      .status(500)
      .json({ error: "No se pudo iniciar el onboarding de WhatsApp" });
  }
});

export default router;
