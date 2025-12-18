import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";
import { graphGet } from "../../lib/meta/whatsappSystemUser";
import { getProviderToken } from "../../lib/meta/getProviderToken";

const router = Router();

router.get(
  "/whatsapp/debug-number",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user: any = (req as any).user;
      const tenantId: string | undefined = user?.tenant_id;

      if (!tenantId) {
        return res.status(401).json({ error: "Tenant no identificado" });
      }

      // 1) Leer de DB: token + wabaId + phoneNumberId
      const t = await pool.query(
        `
        SELECT
          whatsapp_access_token,
          whatsapp_business_id,
          whatsapp_phone_number_id
        FROM tenants
        WHERE id::text = $1
        LIMIT 1
        `,
        [tenantId]
      );

      const tenantToken: string | null = t.rows?.[0]?.whatsapp_access_token || null;
      const wabaId: string | null = t.rows?.[0]?.whatsapp_business_id || null;
      const phoneNumberId: string | null = t.rows?.[0]?.whatsapp_phone_number_id || null;

      if (!wabaId) {
        return res.status(400).json({ error: "Falta whatsapp_business_id (wabaId) en tenant" });
      }
      if (!phoneNumberId) {
        return res.status(400).json({ error: "Falta whatsapp_phone_number_id en tenant" });
      }

      // Para debug consistente tipo Tech Provider, usamos el token del proveedor
      const providerToken = getProviderToken();

      const list = await graphGet(
        `${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,status,code_verification_status,quality_rating,platform_type&limit=200`,
        providerToken
      );

      const subscribedApps = await graphGet(
        `${wabaId}/subscribed_apps?fields=id,name,subscribed_fields`,
        providerToken
      );

      const detail = await graphGet(
        `${phoneNumberId}?fields=id,display_phone_number,verified_name,status,code_verification_status,quality_rating,platform_type`,
        providerToken
      );

      // 4) Responder JSON completo
      return res.json({
        ok: true,
        tenantId,
        wabaId,
        phoneNumberId,
        waba_phone_numbers: list,
        phone_number_detail: detail,
        subscribed_apps: subscribedApps,
      });
    } catch (err: any) {
      console.error("❌ [WA DEBUG NUMBER] Error:", err);
      return res.status(500).json({
        error: "Error interno debug-number",
        detail: String(err?.message || err),
      });
    }
  }
);

router.post(
  "/whatsapp/test-send",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user: any = (req as any).user;
      const tenantId: string | undefined = user?.tenant_id;

      if (!tenantId) return res.status(401).json({ error: "Tenant no identificado" });

      const { to, text } = req.body || {};
      if (!to) return res.status(400).json({ error: "Falta 'to' en body (E.164, ej: +1407...)" });

      const messageText = String(text || "ping desde Aamy Cloud API");

      // 1) Leer token + phoneNumberId del tenant
      const t = await pool.query(
        `
        SELECT whatsapp_access_token, whatsapp_phone_number_id
        FROM tenants
        WHERE id::text = $1
        LIMIT 1
        `,
        [tenantId]
      );

      // 2) Extraer el phoneNumberId del tenant (NECESARIO para el endpoint /{phoneNumberId}/messages)
      const phoneNumberId: string | null = t.rows?.[0]?.whatsapp_phone_number_id || null;

      if (!phoneNumberId) {
        return res.status(400).json({ error: "Tenant sin whatsapp_phone_number_id" });
      }

      // ⚠️ Para enviar mensajes NO uses el token del tenant.
      // Usa el token del proveedor (System User / Tech Provider).
      const providerToken = getProviderToken();

      // 3) Payload del mensaje
      const payload = {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: messageText },
      };

      const resp = await fetch(
        `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${providerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }
      );

      const json: any = await resp.json().catch(() => ({}));

      console.log("🧪 [WA TEST SEND] status:", resp.status);
      console.log("🧪 [WA TEST SEND] response:", JSON.stringify(json, null, 2));

      if (!resp.ok) {
        return res.status(500).json({
          error: "Graph error enviando mensaje",
          status: resp.status,
          detail: json,
        });
      }

      return res.json({ ok: true, result: json });
    } catch (err: any) {
      console.error("❌ [WA TEST SEND] Error:", err);
      return res.status(500).json({ error: "Error interno test-send", detail: String(err?.message || err) });
    }
  }
);

export default router;