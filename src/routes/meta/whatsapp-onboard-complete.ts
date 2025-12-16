// backend/src/routes/meta/whatsapp-onboard-complete.ts
import express, { Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";
import {
  resolveBusinessIdFromWaba,
  createSystemUserAndTokenForBusiness,
  // registerPhoneNumber,
} from "../../lib/meta/whatsappSystemUser";

const router = express.Router();

router.post(
  "/whatsapp/onboard-complete",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const { wabaId, phoneNumberId } = req.body;

      const user: any = (req as any).user;
      const tenantId = user?.tenant_id;

      if (!tenantId) return res.status(401).json({ error: "Tenant no identificado" });
      if (!wabaId || !phoneNumberId) {
        return res.status(400).json({ error: "Faltan wabaId o phoneNumberId" });
      }

      // 1) Guardar WABA + phone number id
      await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_business_id     = $1,
          whatsapp_phone_number_id = $2,
          whatsapp_status          = 'connected',
          whatsapp_connected       = TRUE,
          whatsapp_connected_at    = NOW(),
          updated_at               = NOW()
        WHERE id::text = $3
        `,
        [wabaId, phoneNumberId, tenantId]
      );

      // 2) Traer el token del tenant (el que guardaste al hacer exchange-code)
      const t = await pool.query(
        `SELECT whatsapp_access_token FROM tenants WHERE id::text = $1 LIMIT 1`,
        [tenantId]
      );
      const userToken = t.rows?.[0]?.whatsapp_access_token;
      if (!userToken) {
        return res.status(400).json({
          error:
            "No existe whatsapp_access_token para este tenant. Falta completar exchange-code antes de onboard-complete.",
        });
      }

      // 3) Resolver Business ID dueño del WABA (necesita permisos en ese Business)
      const businessId = await resolveBusinessIdFromWaba(String(wabaId), String(userToken));

      // 4) Crear System User + generar token estable
      const appId = process.env.META_APP_ID || process.env.NEXT_PUBLIC_META_APP_ID;
      if (!appId) {
        return res.status(500).json({ error: "META_APP_ID no configurado en backend" });
      }

      const { systemUserId, systemUserToken } =
        await createSystemUserAndTokenForBusiness({
          businessId,
          userToken,
          appId: String(appId),
        });

      // 5) Guardar en DB
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
        [businessId, systemUserId, systemUserToken, tenantId]
      );

      // 6) (Opcional) registrar el número con PIN desde backend
      //    OJO: para esto necesitas un PIN real definido por el tenant.
      // await registerPhoneNumber({ phoneNumberId, systemUserToken, pin: "123456" });

      return res.json({
        ok: true,
        tenantId,
        wabaId,
        phoneNumberId,
        businessId,
        systemUserId,
        systemUserToken_created: true,
      });
    } catch (err: any) {
      console.error("❌ [WA ONBOARD COMPLETE] Error:", err?.message || err);
      return res.status(500).json({
        error: err?.message || "Error interno guardando la conexión",
      });
    }
  }
);

export default router;
