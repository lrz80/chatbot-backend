// src/routes/meta/whatsapp-register.ts
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
 * POST /api/meta/whatsapp/register
 *
 * Body: { pin: "123456" }
 *
 * Flujo:
 * - Lee tenant.whatsapp_access_token (user token) + wabaId + phoneNumberId
 * - Resuelve businessId (BM) dueño del WABA
 * - Crea system user dentro del BM
 * - Genera system user token con scopes necesarios
 * - Registra el phone_number_id con PIN usando system user token
 * - Guarda todo en DB
 */
router.post(
  "/whatsapp/register",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const tenantId: string | undefined = user?.tenant_id;

      if (!tenantId) {
        return res.status(401).json({ error: "Tenant no identificado." });
      }

      const pin = String((req.body?.pin ?? "")).trim();
      if (!pin) {
        return res.status(400).json({ error: "Falta pin en el body." });
      }

      // 1) Cargar tenant
      const tRes = await pool.query(
        `
        SELECT
          id,
          whatsapp_access_token,
          whatsapp_business_id,
          whatsapp_phone_number_id,
          whatsapp_system_user_id,
          whatsapp_system_user_token,
          whatsapp_business_manager_id
        FROM tenants
        WHERE id::text = $1
        LIMIT 1
        `,
        [tenantId]
      );

      const tenant = tRes.rows?.[0];
      if (!tenant) {
        return res.status(404).json({ error: "Tenant no encontrado." });
      }

      const userToken: string | null = tenant.whatsapp_access_token || null;
      const wabaId: string | null = tenant.whatsapp_business_id || null;
      const phoneNumberId: string | null = tenant.whatsapp_phone_number_id || null;

      if (!userToken) {
        return res.status(400).json({
          error:
            "Este tenant no tiene whatsapp_access_token. Completa Embedded Signup (exchange-code).",
        });
      }

      if (!wabaId || !phoneNumberId) {
        return res.status(400).json({
          error:
            "Falta whatsapp_business_id o whatsapp_phone_number_id en el tenant. Completa onboard-complete primero.",
        });
      }

      const APP_ID = process.env.META_APP_ID;
      if (!APP_ID) {
        return res
          .status(500)
          .json({ error: "Falta META_APP_ID en variables de entorno." });
      }

      // 2) Resolver BM dueño del WABA (whatsapp_business_manager_id)
      let businessManagerId: string = tenant.whatsapp_business_manager_id || "";
      if (!businessManagerId) {
        businessManagerId = await resolveBusinessIdFromWaba(wabaId, userToken);
      }

      // 3) Crear System User si no existe
      let systemUserId: string = tenant.whatsapp_system_user_id || "";
      if (!systemUserId) {
        systemUserId = await createSystemUser({
          businessId: businessManagerId,
          userToken,
          name: "Aamy WhatsApp System User",
          role: "ADMIN",
        });
      }

      // 4) Crear System User Token si no existe (o regenerar siempre si quieres)
      let systemUserToken: string = tenant.whatsapp_system_user_token || "";
      if (!systemUserToken) {
        systemUserToken = await createSystemUserToken({
          systemUserId,
          userToken,
          appId: APP_ID,
          scopesCsv:
            "whatsapp_business_management,whatsapp_business_messaging,business_management",
        });
      }

      // 5) Registrar número con PIN usando SYSTEM USER TOKEN
      const registerResp = await registerPhoneNumber({
        phoneNumberId,
        systemUserToken,
        pin,
      });

      // 6) Guardar en DB todo lo generado
      await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_business_manager_id = $1,
          whatsapp_system_user_id      = $2,
          whatsapp_system_user_token   = $3,
          whatsapp_status              = 'connected',
          whatsapp_connected           = TRUE,
          whatsapp_connected_at        = COALESCE(whatsapp_connected_at, NOW()),
          updated_at                   = NOW()
        WHERE id::text = $4
        `,
        [businessManagerId, systemUserId, systemUserToken, tenantId]
      );

      return res.json({
        ok: true,
        businessManagerId,
        systemUserId,
        registered: true,
        meta: registerResp,
      });
    } catch (err: any) {
      console.error("❌ [WA REGISTER] Error:", err?.message || err);

      return res.status(500).json({
        error: "Error registrando número WhatsApp (register).",
        detail: String(err?.message || err),
      });
    }
  }
);

export default router;
