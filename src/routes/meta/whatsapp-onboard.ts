// src/routes/meta/whatsapp-onboard.ts
import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = Router();

const META_APP_ID = process.env.META_APP_ID || "";
const META_APP_SECRET = process.env.META_APP_SECRET || "";
const META_WHATSAPP_REDIRECT_URI = process.env.META_WHATSAPP_REDIRECT_URI || "";

if (!META_APP_ID || !META_APP_SECRET || !META_WHATSAPP_REDIRECT_URI) {
  console.warn(
    "⚠️ META_APP_ID / META_APP_SECRET / META_WHATSAPP_REDIRECT_URI no configuradas correctamente"
  );
}

// POST /api/meta/whatsapp/onboard-complete
router.post(
  "/whatsapp/onboard-complete",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const tenantId = user?.tenant_id;

      console.log("🚀 [META WA] POST /api/meta/whatsapp/onboard-complete BODY:", req.body);
      console.log("👤 [META WA] Tenant desde sesión:", tenantId);

      if (!tenantId) {
        return res.status(401).json({ error: "Tenant no encontrado en sesión" });
      }

      const { code } = req.body as { code?: string };

      if (!code) {
        return res
          .status(400)
          .json({ error: "No se recibió el código (code) de Meta" });
      }

      // 1) Intercambiar code -> access_token
      const tokenUrl =
        `https://graph.facebook.com/v20.0/oauth/access_token` +
        `?client_id=${encodeURIComponent(META_APP_ID)}` +
        `&client_secret=${encodeURIComponent(META_APP_SECRET)}` +
        `&redirect_uri=${encodeURIComponent(META_WHATSAPP_REDIRECT_URI)}` +
        `&code=${encodeURIComponent(code)}`;

      console.log("🌐 [META WA] Llamando a:", tokenUrl);

      const tokenResp = await fetch(tokenUrl);
      const tokenJson: any = await tokenResp.json().catch(() => ({}));

      console.log(
        "🔑 [META WA] Respuesta oauth/access_token status=",
        tokenResp.status,
        "body=",
        tokenJson
      );

      if (!tokenResp.ok || !tokenJson.access_token) {
        return res.status(500).json({
          error:
            "No se pudo obtener el access_token de Meta. Revisa APP_ID/SECRET y redirect_uri.",
          meta_error: tokenJson,
        });
      }

      const accessToken = tokenJson.access_token as string;

      // 2) Obtener los WhatsApp Business Accounts y teléfonos
      const wabaUrl =
        "https://graph.facebook.com/v20.0/me" +
        "?fields=whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number}}" +
        `&access_token=${encodeURIComponent(accessToken)}`;

      console.log("🌐 [META WA] Llamando a:", wabaUrl);

      const wabaResp = await fetch(wabaUrl);
      const wabaJson: any = await wabaResp.json().catch(() => ({}));

      console.log(
        "🏢 [META WA] Respuesta me{whatsapp_business_accounts} status=",
        wabaResp.status,
        "body=",
        JSON.stringify(wabaJson, null, 2)
      );

      if (!wabaResp.ok) {
        return res.status(500).json({
          error:
            "No se pudo obtener la información de la cuenta de WhatsApp Business.",
          meta_error: wabaJson,
        });
      }

      const waba =
        wabaJson?.whatsapp_business_accounts?.data?.[0] ||
        wabaJson?.whatsapp_business_accounts?.[0] ||
        null;

      const phone =
        waba?.phone_numbers?.data?.[0] ||
        waba?.phone_numbers?.[0] ||
        null;

      const wabaId = waba?.id || null;
      const phoneNumberId = phone?.id || null;
      const displayPhoneNumber = phone?.display_phone_number || null;

      console.log("📌 [META WA] Parsed ->", {
        wabaId,
        phoneNumberId,
        displayPhoneNumber,
      });

      if (!wabaId || !phoneNumberId || !displayPhoneNumber) {
        return res.status(500).json({
          error:
            "No se pudo detectar el WABA o el número de WhatsApp desde la respuesta de Meta.",
          meta_raw: wabaJson,
        });
      }

      // 3) Guardar en tenants
      await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_business_id      = $1,
          whatsapp_phone_number_id  = $2,
          whatsapp_phone_number     = $3,
          whatsapp_access_token     = $4,
          whatsapp_connected        = TRUE,
          whatsapp_connected_at     = NOW(),
          whatsapp_status           = 'connected',
          updated_at                = NOW()
        WHERE id = $5
      `,
        [
          wabaId,
          phoneNumberId,
          displayPhoneNumber,
          accessToken,
          tenantId,
        ]
      );

      console.log("✅ [META WA] WhatsApp conectado para tenant", tenantId, {
        wabaId,
        phoneNumberId,
        displayPhoneNumber,
      });

      return res.json({
        success: true,
        waba_id: wabaId,
        phone_number_id: phoneNumberId,
        phone_number: displayPhoneNumber,
      });
    } catch (err: any) {
      console.error("❌ [META WA] Error en /whatsapp/onboard-complete:", err);
      return res
        .status(500)
        .json({ error: "Error interno guardando datos de WhatsApp" });
    }
  }
);

export default router;
