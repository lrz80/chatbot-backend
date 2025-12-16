// backend/src/routes/meta/whatsapp-onboard-complete.ts
import express, { Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

import {
  resolveBusinessIdFromWaba,
  createSystemUser,
  createSystemUserToken,
  registerPhoneNumber,
} from "../../lib/meta/whatsappSystemUser";

const router = express.Router();

/**
 * POST /api/meta/whatsapp/onboard-complete
 *
 * Llamado desde el frontend al terminar Embedded Signup.
 * Guarda wabaId + phoneNumberId y (opcional) crea System User + token y registra el número con PIN.
 *
 * Body:
 *  - wabaId: string
 *  - phoneNumberId: string
 *  - pin?: string (opcional; si lo mandas, intentamos register del número)
 */
router.post(
  "/whatsapp/onboard-complete",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const { wabaId, phoneNumberId, pin } = req.body as {
        wabaId?: string;
        phoneNumberId?: string;
        pin?: string;
      };

      const user: any = (req as any).user;
      const tenantId: string | undefined = user?.tenant_id;

      console.log("[WA ONBOARD COMPLETE] Body recibido:", {
        wabaId,
        phoneNumberId,
        tenantId,
        hasPin: Boolean(pin),
      });

      if (!tenantId) {
        return res.status(401).json({ error: "Tenant no identificado" });
      }
      if (!wabaId || !phoneNumberId) {
        return res
          .status(400)
          .json({ error: "Faltan wabaId o phoneNumberId en el cuerpo" });
      }

      // 1) Guardar WABA + phone_number_id + status connected
      const updateBase = await pool.query(
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
          whatsapp_connected_at,
          whatsapp_access_token;
        `,
        [wabaId, phoneNumberId, tenantId]
      );

      const tenant = updateBase.rows?.[0];

      if (!tenant) {
        return res.status(404).json({ error: "Tenant no encontrado" });
      }

      // IMPORTANTE:
      // whatsapp_access_token (guardado en /whatsapp/exchange-code) es el token del tenant (user access token).
      const tenantUserToken: string | undefined = tenant.whatsapp_access_token;

      // Si aún no tienes whatsapp_access_token guardado, igual dejamos connected,
      // pero no podemos crear system user/token ni registrar.
      if (!tenantUserToken) {
        console.warn(
          "[WA ONBOARD COMPLETE] El tenant NO tiene whatsapp_access_token aún. " +
            "Se guardó wabaId/phoneNumberId, pero no se creó system user."
        );

        return res.json({
          ok: true,
          tenant: {
            ...tenant,
            note: "Falta whatsapp_access_token; no se creó system user ni se registró el número.",
          },
        });
      }

      // 2) Resolver Business Manager ID dueño del WABA
      const businessManagerId = await resolveBusinessIdFromWaba(
        wabaId,
        tenantUserToken
      );

      // 3) Crear System User dentro del BM del tenant
      const systemUserId = await createSystemUser({
        businessId: businessManagerId,
        userToken: tenantUserToken,
        name: "Aamy WhatsApp System User",
        role: "ADMIN",
      });

      // 4) Crear System User Token (scopes WA)
      const appId = process.env.META_APP_ID;
      if (!appId) {
        return res.status(500).json({ error: "Falta META_APP_ID en el backend" });
      }

      const systemUserToken = await createSystemUserToken({
        systemUserId,
        userToken: tenantUserToken,
        appId,
        // puedes ajustar scopes si lo necesitas:
        scopesCsv:
          "whatsapp_business_management,whatsapp_business_messaging,business_management",
      });

      // 5) Guardar BM + system user + token en tenants
      await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_business_manager_id = $1,
          whatsapp_system_user_id      = $2,
          whatsapp_system_user_token   = $3,
          updated_at                   = NOW()
        WHERE id::text = $4
        `,
        [businessManagerId, systemUserId, systemUserToken, tenantId]
      );

      // 6) (Opcional) Registrar phone number con PIN si viene
      let registerResult: any = null;
      if (pin && String(pin).trim()) {
        try {
          registerResult = await registerPhoneNumber({
            phoneNumberId,
            systemUserToken,
            pin: String(pin).trim(),
          });
        } catch (e: any) {
          console.error("[WA REGISTER] Error registrando phone number:", e?.message || e);
          // No bloqueamos todo el onboarding por el register:
          registerResult = { ok: false, error: e?.message || "register failed" };
        }
      }

      // 7) Respuesta final
      return res.json({
        ok: true,
        tenant: {
          id: tenantId,
          whatsapp_business_id: wabaId,
          whatsapp_phone_number_id: phoneNumberId,
          whatsapp_business_manager_id: businessManagerId,
          whatsapp_system_user_id: systemUserId,
          // no devuelvo el token completo por seguridad, pero puedes si quieres:
          whatsapp_system_user_token_present: Boolean(systemUserToken),
        },
        register: registerResult,
      });
    } catch (err: any) {
      console.error("❌ [WA ONBOARD COMPLETE] Error:", err?.message || err);
      return res.status(500).json({
        error: "Error interno guardando la conexión",
        detail: err?.message || String(err),
      });
    }
  }
);

export default router;
