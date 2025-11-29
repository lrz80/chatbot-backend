// src/routes/meta/whatsapp-onboard-start.ts
import express, { Request, Response } from "express";

const router = express.Router();

/**
 * POST /api/meta/whatsapp-onboard/start
 *
 * Devuelve la URL de Embedded Signup (Meta-hosted)
 * para que el frontend la abra en un popup.
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const APP_ID = process.env.META_APP_ID;
    const CONFIG_ID = process.env.META_EMBEDDED_SIGNUP_CONFIG_ID; // ⚠️ nueva env

    if (!APP_ID || !CONFIG_ID) {
      console.error(
        "[WA ONBOARD START] Falta META_APP_ID o META_EMBEDDED_SIGNUP_CONFIG_ID"
      );
      return res
        .status(500)
        .json({ error: "Falta configuración de Meta (APP_ID o CONFIG_ID)" });
    }

    // tenantId viene del body o del token, igual que antes
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

    // 🔗 URL pública de tu backend
    const BACKEND_PUBLIC_URL =
      process.env.BACKEND_PUBLIC_URL || "https://api.aamy.ai";

    const redirectUri = `${BACKEND_PUBLIC_URL}/api/meta/whatsapp/callback`;

    // ✅ URL correcta de Embedded Signup (Meta-hosted)
    const url = new URL(
      "https://business.facebook.com/messaging/whatsapp/onboard/"
    );
    url.searchParams.set("app_id", APP_ID);
    url.searchParams.set("config_id", CONFIG_ID);
    // Muy útil para multi-tenant:
    url.searchParams.set("state", tenantId);
    // 👉 CLAVE: decirle a Meta a dónde debe regresar
    url.searchParams.set("redirect_uri", redirectUri);

    console.log("🌐 [WA ONBOARD START] URL Embedded Signup:", url.toString());

    return res.json({ url: url.toString() });
  } catch (err) {
    console.error("❌ [WA ONBOARD START] Error inesperado:", err);
    return res
      .status(500)
      .json({ error: "No se pudo iniciar el onboarding de WhatsApp" });
  }
});

export default router;
