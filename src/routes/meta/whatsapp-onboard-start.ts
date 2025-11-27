// src/routes/meta/whatsapp-onboard-start.ts
import express, { Request, Response } from "express";

const router = express.Router();

router.post("/", async (req: Request, res: Response) => {
  try {
    const APP_ID = process.env.META_APP_ID;
    const CONFIG_ID = process.env.META_CONFIG_ID;
    const BACKEND_PUBLIC_URL =
      process.env.BACKEND_PUBLIC_URL || "https://api.aamy.ai";

    if (!APP_ID || !CONFIG_ID) {
      console.error("[WA ONBOARD START] Falta APP_ID o CONFIG_ID");
      return res.status(500).json({
        error:
          "Falta configuración del App de Meta (META_APP_ID o META_CONFIG_ID).",
      });
    }

    // tenantId viene del body o desde req.user
    const tenantId =
      (req.body?.tenantId as string) ||
      // @ts-ignore
      req.user?.tenant_id;

    if (!tenantId) {
      return res.status(400).json({ error: "Falta tenantId" });
    }

    /**
     * URL oficial de Embedded Signup con soporte multi-tenant (state)
     * Incluye app_id + config_id + estado con tenantId.
     */
    const url = `https://business.facebook.com/messaging/whatsapp/onboard/?app_id=${APP_ID}&config_id=${CONFIG_ID}&state=${tenantId}`;

    console.log("🌐 URL Embedded Signup generada:", url);

    return res.json({ url });
  } catch (err) {
    console.error("❌ [WA ONBOARD START] Error inesperado:", err);
    return res
      .status(500)
      .json({ error: "No se pudo iniciar el onboarding de WhatsApp" });
  }
});

export default router;
