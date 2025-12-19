import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";
import {
  subscribeAppToWaba,
  getSubscribedAppsFromWaba,
} from "../../lib/meta/whatsappSystemUser";
import { getProviderToken } from "../../lib/meta/getProviderToken";

const router = Router();

const APP_ID = process.env.META_APP_ID || process.env.NEXT_PUBLIC_META_APP_ID || "";

router.post(
  "/whatsapp/onboard-complete",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user: any = (req as any).user;
      const tenantId: string | undefined = user?.tenant_id || user?.tenantId;

      // Soportar variaciones de nombres que puedas enviar desde frontend
      const wabaId: string | undefined =
        req.body?.wabaId ||
        req.body?.waba_id ||
        req.body?.whatsapp_business_id ||
        req.body?.business_id;

      const phoneNumberId: string | undefined =
        req.body?.phoneNumberId ||
        req.body?.phone_number_id ||
        req.body?.phoneNumberID ||
        req.body?.whatsapp_phone_number_id;

      console.log("🧪 [WA ONBOARD COMPLETE] req.body raw:", req.body);
      console.log("🧪 [WA ONBOARD COMPLETE] req.user raw:", (req as any).user);
      console.log("[WA ONBOARD COMPLETE] Body recibido:", {
        tenantId,
        wabaId,
        phoneNumberId,
      });

      if (!tenantId) {
        return res.status(401).json({ ok: false, error: "Tenant no identificado" });
      }
      if (!wabaId || !phoneNumberId) {
        return res.status(400).json({
          ok: false,
          error: "Faltan wabaId o phoneNumberId en el cuerpo",
          got: { wabaId, phoneNumberId },
        });
      }

      // 1) Guardar conexión en DB (una sola vez, definitivo)
      const update = await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_business_id       = $1,
          whatsapp_phone_number_id   = $2,
          whatsapp_status            = 'connected',
          whatsapp_connected         = TRUE,
          whatsapp_connected_at      = NOW(),
          updated_at                 = NOW()
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

      // 2) Suscribir la app al WABA (recomendado para eventos/webhooks)
      //    OJO: esto debe usar Provider/System User token (no el tenant token).
      try {
        const providerToken = getProviderToken();
        if (!providerToken) {
          console.warn("⚠️ [WA ONBOARD COMPLETE] providerToken vacío. No se pudo suscribir app al WABA.");
        } else {
          const sub = await subscribeAppToWaba(wabaId, providerToken);
          console.log("✅ [WA ONBOARD COMPLETE] subscribeAppToWaba OK:", sub);
        }
      } catch (e: any) {
        console.warn("⚠️ [WA ONBOARD COMPLETE] subscribeAppToWaba FAIL:", e?.message || e);
      }

      // 3) Verificar subscribed_apps (solo logging; no debe romper el flujo)
      try {
        const providerToken = getProviderToken();
        if (!providerToken) {
          console.warn("⚠️ [WA ONBOARD COMPLETE] providerToken vacío. No se pudo leer subscribed_apps.");
        } else {
          const apps = await getSubscribedAppsFromWaba(wabaId, providerToken);

          console.log(
            "🔍 [WA ONBOARD COMPLETE] subscribed_apps LIST:",
            JSON.stringify(apps, null, 2)
          );

          const list = Array.isArray((apps as any)?.data) ? (apps as any).data : [];
          const isSubscribed =
            !!APP_ID && list.some((a: any) => String(a?.id) === String(APP_ID));

          if (!APP_ID) {
            console.warn("⚠️ [WA ONBOARD COMPLETE] APP_ID no configurado; no se puede validar subscribed_apps contra tu app.");
          } else if (!isSubscribed) {
            console.error("❌ [WA ONBOARD COMPLETE] Tu app NO aparece en subscribed_apps del WABA (o Graph devolvió shape distinto).");
          } else {
            console.log("✅ [WA ONBOARD COMPLETE] App confirmada en subscribed_apps");
          }
        }
      } catch (e: any) {
        console.error("❌ [WA ONBOARD COMPLETE] Error leyendo subscribed_apps:", e?.message || e);
      }

      return res.json({
        ok: true,
        tenant: update.rows?.[0],
      });
    } catch (err: any) {
      console.error("❌ [WA ONBOARD COMPLETE] Error:", err);
      return res.status(500).json({
        ok: false,
        error: "Error interno guardando la conexión",
        detail: String(err?.message || err),
      });
    }
  }
);

export default router;
