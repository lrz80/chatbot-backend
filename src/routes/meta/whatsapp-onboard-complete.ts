import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";
import {
  subscribeAppToWaba,
  getSubscribedAppsFromWaba,
} from "../../lib/meta/whatsappSystemUser";
import { getProviderToken } from "../../lib/meta/getProviderToken";

const router = Router();

router.post(
  "/whatsapp/onboard-complete",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user: any = (req as any).user;
      const tenantId: string | undefined = user?.tenant_id;

      const wabaId: string | undefined = req.body?.wabaId;
      const phoneNumberId: string | undefined =
        req.body?.phoneNumberId || req.body?.phone_number_id;

      console.log("[WA ONBOARD COMPLETE] Body recibido:", {
        wabaId,
        phoneNumberId,
        tenantId,
      });

      console.log("🧪 [WA ONBOARD COMPLETE] req.body raw:", req.body);
      console.log("🧪 [WA ONBOARD COMPLETE] req.user raw:", (req as any).user);

      if (!tenantId) {
        return res.status(401).json({ error: "Tenant no identificado" });
      }
      if (!wabaId || !phoneNumberId) {
        return res.status(400).json({
          error: "Faltan wabaId o phoneNumberId en el cuerpo",
        });
      }

      // 1) Leer token del tenant (guardado previamente en /exchange-code)
      const t = await pool.query(
        `
        SELECT whatsapp_access_token
        FROM tenants
        WHERE id::text = $1
        LIMIT 1
        `,
        [tenantId]
      );

      const tenantToken: string | null = t.rows?.[0]?.whatsapp_access_token || null;

      console.log("🧪 [WA ONBOARD COMPLETE] tenant has whatsapp_access_token:", !!tenantToken);

      // 1.5) Guardar wabaId + phoneNumberId inmediatamente (aunque falle después)
      // Esto evita quedar “a medias” y te deja trazabilidad en DB.
      await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_business_id     = $1,
          whatsapp_phone_number_id = $2,
          updated_at               = NOW()
        WHERE id::text = $3
        `,
        [wabaId, phoneNumberId, tenantId]
      );

      // 1.2) Suscribir la app al WABA (clave para que lleguen webhooks inbound)
      try {
        const providerToken = getProviderToken();
        const sub = await subscribeAppToWaba(wabaId, providerToken);
        console.log("✅ [WA ONBOARD COMPLETE] subscribed_apps OK:", sub);
      } catch (e: any) {
        console.warn("⚠️ [WA ONBOARD COMPLETE] subscribed_apps FAIL:", e?.message || e);
      }

      // 1.3) Verificar que el WABA quedó realmente suscrito
      try {
        const providerToken = getProviderToken();
        const apps = await getSubscribedAppsFromWaba(wabaId, providerToken);

        console.log(
          "🔍 [WA ONBOARD COMPLETE] subscribed_apps LIST:",
          JSON.stringify(apps, null, 2)
        );

        const appId = process.env.META_APP_ID;

        const isSubscribed =
          Array.isArray(apps?.data) &&
          apps.data.some((a: any) =>
            String(a?.id || a?.whatsapp_business_api_data?.id) === String(appId)
          );

        if (!isSubscribed) {
          console.error("❌ [WA ONBOARD COMPLETE] App NO está suscrita al WABA (o Graph devolvió shape distinto)");
        } else {
          console.log("✅ [WA ONBOARD COMPLETE] App confirmada en subscribed_apps");
        }
      } catch (e: any) {
        console.error(
          "❌ [WA ONBOARD COMPLETE] Error leyendo subscribed_apps:",
          e?.message || e
        );
      }

      // 2) Resolver Business Manager ID dueño del WABA
      // const businessManagerId = await resolveBusinessIdFromWaba(wabaId, tenantToken);

      // 4) Crear System User Token (scopes WA)
      const appId = process.env.META_APP_ID;
      if (!appId) {
        return res.status(500).json({ error: "Falta META_APP_ID en env." });
      }

      const update = await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_business_id      = $1,
          whatsapp_phone_number_id  = $2,
          whatsapp_status           = 'connected',
          whatsapp_connected        = TRUE,
          whatsapp_connected_at     = NOW(),
          updated_at                = NOW()
        WHERE id::text = $3
        RETURNING
          id,
          whatsapp_business_id,
          whatsapp_phone_number_id,
          whatsapp_status,
          whatsapp_connected,
          whatsapp_connected_at;
        `,
        [wabaId, phoneNumberId, tenantId]
      );

      
      console.log(
        "💾 [WA ONBOARD COMPLETE] UPDATE rowCount:",
        update.rowCount,
        "rows:",
        update.rows
      );

      return res.json({
        ok: true,
        tenant: update.rows?.[0],
      });
    } catch (err: any) {
      console.error("❌ [WA ONBOARD COMPLETE] Error:", err);
      return res.status(500).json({
        error: "Error interno guardando la conexión",
        detail: String(err?.message || err),
      });
    }
  }
);

export default router;