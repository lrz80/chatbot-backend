// src/routes/meta/whatsapp-phone-numbers.ts
import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = Router();

/**
 * GET /api/meta/whatsapp/phone-numbers
 *
 * Lista las WABA y números disponibles para el tenant actual.
 * - Usa el whatsapp_access_token y whatsapp_business_id guardados en tenants.
 * - NO usa /me/businesses ni owned_whatsapp_business_accounts.
 * - NO guarda nada en la base de datos. Solo lista.
 */
router.get(
  "/whatsapp/phone-numbers",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const tenantId =
        (req as any).user?.tenant_id || (req as any).user?.tenantId;

      console.log("🧪 [WA PHONE NUMBERS] tenantId:", tenantId);
      console.log("🧪 [WA PHONE NUMBERS] req.user:", (req as any).user);

      if (!tenantId) {
        return res.status(401).json({ error: "No autenticado" });
      }

      // 1️⃣ Obtener access_token y WABA ID desde la DB
      const { rows } = await pool.query(
        `
        SELECT
          whatsapp_access_token,
          whatsapp_business_id
        FROM tenants
        WHERE id::text = $1
        LIMIT 1
        `,
        [tenantId]
      );

      console.log("🧪 [WA PHONE NUMBERS] tenants rows length:", rows?.length || 0);

      if (!rows || rows.length === 0) {
        console.warn("[WA PHONE NUMBERS] Tenant no encontrado en DB:", tenantId);
        return res.json({ accounts: [], status: "tenant_not_found" });
      }

      console.log(
        "🧪 [WA PHONE NUMBERS] has accessToken:",
        !!rows?.[0]?.whatsapp_access_token
      );
      console.log(
        "🧪 [WA PHONE NUMBERS] has wabaId:",
        !!rows?.[0]?.whatsapp_business_id
      );

      const accessToken = rows[0]?.whatsapp_access_token as string | undefined;
      const wabaId = rows[0]?.whatsapp_business_id as string | undefined;

      if (!accessToken) {
        console.warn("[WA PHONE NUMBERS] Sin whatsapp_access_token en tenant");
        return res.json({ accounts: [], status: "no_token" });
      }

      if (!wabaId) {
        console.warn(
          "[WA PHONE NUMBERS] Sin whatsapp_business_id en tenant (WABA no configurada)"
        );
        return res.json({ accounts: [], status: "no_waba_configured" });
      }

      // 2️⃣ Info básica de la WABA
      const wabaInfoUrl =
        `https://graph.facebook.com/v18.0/${encodeURIComponent(wabaId)}` +
        `?fields=id,name&access_token=${encodeURIComponent(accessToken)}`;

      console.log("[WA PHONE NUMBERS] Consultando info WABA:", wabaInfoUrl);

      const wabaInfoResp = await fetch(wabaInfoUrl);
      const wabaInfoJson: any = await wabaInfoResp.json();

      if (!wabaInfoResp.ok) {
        console.error("[WA PHONE NUMBERS] Error info WABA:", wabaInfoJson);
        return res.status(500).json({
          error: "Error obteniendo info de la WABA",
          detail: wabaInfoJson,
        });
      }

      // 3️⃣ Edge de números: /{WABA_ID}/phone_numbers
      const phonesUrl =
        `https://graph.facebook.com/v18.0/${encodeURIComponent(wabaId)}` +
        `/phone_numbers?access_token=${encodeURIComponent(accessToken)}`;

      console.log("[WA PHONE NUMBERS] Consultando números:", phonesUrl);

      const phonesResp = await fetch(phonesUrl);
      const phonesJson: any = await phonesResp.json();

      console.log(
        "[WA PHONE NUMBERS] Respuesta /phone_numbers:",
        JSON.stringify(phonesJson, null, 2)
      );

      if (!phonesResp.ok) {
        console.error("[WA PHONE NUMBERS] Error desde Graph:", phonesJson);
        return res.status(500).json({
          error: "Meta Graph devolvió un error al listar números de WhatsApp",
          detail: phonesJson,
        });
      }

      const phones = (phonesJson.data ?? []) as any[];

      type Account = {
        waba_id: string;
        waba_name: string | null;
        phone_numbers: {
          phone_number_id: string;
          display_phone_number: string;
          verified_name: string | null;
          code_verification_status: string | null;
        }[];
      };

      const phone_numbers = phones.map((p: any) => ({
        phone_number_id: String(p.id),
        display_phone_number: String(p.display_phone_number),
        verified_name: (p.verified_name as string) ?? null,
        code_verification_status: (p.code_verification_status as string) ?? null,
      }));

      const accounts: Account[] = [];

      if (phone_numbers.length > 0) {
        accounts.push({
          waba_id: String(wabaInfoJson.id ?? wabaId),
          waba_name: (wabaInfoJson.name as string) ?? null,
          phone_numbers,
        });
      }

      console.log(
        "[WA PHONE NUMBERS] Total WABAs con números encontrados:",
        accounts.length
      );

      if (!accounts.length) {
        return res.json({ accounts: [], status: "no_waba" });
      }

      return res.json({ accounts, status: "ok" });
    } catch (error) {
      console.error("[WA PHONE NUMBERS] Error inesperado:", error);
      return res
        .status(500)
        .json({ error: "Error consultando números de WhatsApp." });
    }
  }
);

/**
 * POST /api/meta/whatsapp/select-number
 *
 * Guarda en tenants el número y WABA que el cliente haya elegido en el dashboard.
 */
router.post(
  "/whatsapp/select-number",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const tenantId =
        (req as any).user?.tenant_id || (req as any).user?.tenantId;

      console.log("🧪 [WA SELECT NUMBER] tenantId:", tenantId);
      console.log("🧪 [WA SELECT NUMBER] req.user:", (req as any).user);
      console.log("🧪 [WA SELECT NUMBER] body:", req.body);

      if (!tenantId) {
        return res
          .status(401)
          .json({ error: "No se encontró tenantId en el usuario" });
      }

      const { wabaId, phoneNumberId, displayPhoneNumber } = req.body as {
        wabaId?: string;
        phoneNumberId?: string;
        displayPhoneNumber?: string;
      };

      if (!wabaId || !phoneNumberId || !displayPhoneNumber) {
        return res.status(400).json({
          error: "Faltan wabaId, phoneNumberId o displayPhoneNumber",
        });
      }

      await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_business_id     = $1,
          whatsapp_phone_number_id = $2,
          whatsapp_phone_number    = $3,
          updated_at               = NOW()
        WHERE id::text = $4
        `,
        [wabaId, phoneNumberId, displayPhoneNumber, tenantId]
      );

      return res.json({ ok: true });
    } catch (err) {
      console.error("[WA SELECT NUMBER] Error:", err);
      return res.status(500).json({ error: "Error al guardar el número" });
    }
  }
);

export default router;
