// src/routes/meta/index.ts
import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import whatsappCallback from "./whatsapp-callback";
import whatsappRedirect from "./whatsapp-redirect";

const router = Router();

/**
 * POST /api/meta/whatsapp-onboard/start
 *
 * Genera la URL de OAuth de Meta para conectar WhatsApp Cloud.
 * El frontend abre esta URL en un popup.
 */
router.post("/whatsapp-onboard/start", async (req: Request, res: Response) => {
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
    const tenantIdFromBody = (req.body as any)?.tenantId
      ? String((req.body as any).tenantId).trim()
      : undefined;

    const tenantId =
      tenantIdFromBody ||
      // si tienes auth que rellena req.user
      (req as any).user?.tenant_id;

    if (!tenantId) {
      console.warn("[WA ONBOARD START] No se recibió tenantId");
      return res
        .status(400)
        .json({ error: "Falta tenantId para iniciar el onboarding" });
    }

    const redirectUri = `${BACKEND_PUBLIC_URL}/api/meta/whatsapp/callback`;

    const scopes = [
      "whatsapp_business_management",
      "whatsapp_business_messaging",
      "pages_show_list",
    ].join(",");

    const url = new URL("https://www.facebook.com/v18.0/dialog/oauth");
    url.searchParams.set("client_id", APP_ID);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", tenantId); // importantísimo
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

/**
 * GET /api/meta/whatsapp/accounts
 *
 * Devuelve los números de WhatsApp conectados para el tenant autenticado.
 * El frontend lo usa para mostrar "Ver números disponibles".
 */
router.get("/whatsapp/accounts", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const tenantId = user?.tenant_id as string | undefined;

    if (!tenantId) {
      return res
        .status(401)
        .json({ error: "No autenticado: falta tenant_id en el token." });
    }

    const { rows } = await pool.query(
      `SELECT
         whatsapp_business_id,
         whatsapp_phone_number_id,
         whatsapp_phone_number,
         name
       FROM tenants
       WHERE id = $1
       LIMIT 1`,
      [tenantId]
    );

    const row = rows[0];
    if (!row) {
      return res.status(404).json({ error: "Tenant no encontrado." });
    }

    const phoneNumbers: Array<{
      waba_id: string | null;
      phone_number_id: string | null;
      display_phone_number: string | null;
      verified_name: string | null;
    }> = [];

    if (row.whatsapp_phone_number_id && row.whatsapp_phone_number) {
      phoneNumbers.push({
        waba_id: row.whatsapp_business_id ?? null,
        phone_number_id: row.whatsapp_phone_number_id ?? null,
        display_phone_number: row.whatsapp_phone_number ?? null,
        verified_name: row.name ?? null,
      });
    }

    // Exponemos tanto "phoneNumbers" como "accounts" por compatibilidad
    return res.json({
      phoneNumbers,
      accounts: phoneNumbers,
    });
  } catch (err) {
    console.error("[WA ACCOUNTS] Error listando números:", err);
    return res
      .status(500)
      .json({ error: "Error listando cuentas de WhatsApp." });
  }
});

/**
 * Callback OAuth de Meta para WhatsApp:
 * GET /api/meta/whatsapp/callback
 */
router.use("/whatsapp/callback", whatsappCallback);

/**
 * Ruta opcional de redirect para el front:
 * GET /api/meta/whatsapp-redirect
 */
router.use("/whatsapp-redirect", whatsappRedirect);

export default router;
