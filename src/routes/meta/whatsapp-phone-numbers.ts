// src/routes/meta/whatsapp-phone-numbers.ts
import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = Router();

/**
 * GET /api/meta/whatsapp/phone-numbers
 *
 * Descubre todos los WABA y sus números disponibles para el tenant actual.
 * NO guarda nada en la base de datos. Solo lista.
 */
router.get(
  "/whatsapp/phone-numbers",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const tenantId =
        (req as any).user?.tenant_id || (req as any).user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({ error: "No autenticado" });
      }

      // 1️⃣ Obtener access_token desde la DB
      const { rows } = await pool.query(
        `SELECT whatsapp_access_token FROM tenants WHERE id = $1 LIMIT 1`,
        [tenantId]
      );

      const accessToken = rows[0]?.whatsapp_access_token as string | undefined;
      if (!accessToken) {
        console.warn("[WA PHONE NUMBERS] Sin whatsapp_access_token en tenant");
        return res.json({ accounts: [], status: "no_token" });
      }

      // 2️⃣ Obtener todas las businesses vinculadas al usuario (token)
      const businessResp = await fetch(
        `https://graph.facebook.com/v18.0/me/businesses?access_token=${encodeURIComponent(
          accessToken
        )}`
      );
      const businessData: any = await businessResp.json();

      console.log(
        "[WA PHONE NUMBERS] /me/businesses =>",
        JSON.stringify(businessData, null, 2)
      );

      const businesses: any[] = Array.isArray(businessData?.data)
        ? businessData.data
        : [];

      if (!businesses.length) {
        console.warn("[WA PHONE NUMBERS] Usuario sin businesses");
        return res.json({ accounts: [], status: "no_business" });
      }

      // 3️⃣ Para cada business, buscar WABAs (owned + client) y sus números
      const accounts: Array<{
        business_id: string;
        business_name?: string;
        waba_id: string;
        waba_type: "owned" | "client";
        phone_numbers: {
          phone_number_id: string;
          display_phone_number: string;
          verified_name?: string;
        }[];
      }> = [];

      for (const biz of businesses) {
        const bizId = biz.id as string;
        const bizName = biz.name as string | undefined;

        // owned_whatsapp_business_accounts
        try {
          const ownedResp = await fetch(
            `https://graph.facebook.com/v18.0/${encodeURIComponent(
              bizId
            )}/owned_whatsapp_business_accounts?access_token=${encodeURIComponent(
              accessToken
            )}`
          );
          const ownedJson: any = await ownedResp.json();
          console.log(
            `[WA PHONE NUMBERS] owned_whatsapp_business_accounts (biz ${bizId}) =>`,
            JSON.stringify(ownedJson, null, 2)
          );

          const ownedWabas: any[] = Array.isArray(ownedJson?.data)
            ? ownedJson.data
            : [];

          for (const w of ownedWabas) {
            const wabaId = w.id as string;

            const phoneResp = await fetch(
              `https://graph.facebook.com/v18.0/${encodeURIComponent(
                wabaId
              )}/phone_numbers?access_token=${encodeURIComponent(accessToken)}`
            );
            const phoneData: any = await phoneResp.json();

            console.log(
              `[WA PHONE NUMBERS] /${wabaId}/phone_numbers (owned) =>`,
              JSON.stringify(phoneData, null, 2)
            );

            const phone_numbers: any[] = Array.isArray(phoneData?.data)
              ? phoneData.data
              : [];

            if (phone_numbers.length) {
              accounts.push({
                business_id: bizId,
                business_name: bizName,
                waba_id: wabaId,
                waba_type: "owned",
                phone_numbers: phone_numbers.map((p: any) => ({
                  phone_number_id: p.id,
                  display_phone_number: p.display_phone_number,
                  verified_name: p.verified_name,
                })),
              });
            }
          }
        } catch (ownedErr) {
          console.warn(
            `[WA PHONE NUMBERS] Error en owned_whatsapp_business_accounts (biz ${bizId}):`,
            ownedErr
          );
        }

        // client_whatsapp_business_accounts
        try {
          const clientResp = await fetch(
            `https://graph.facebook.com/v18.0/${encodeURIComponent(
              bizId
            )}/client_whatsapp_business_accounts?access_token=${encodeURIComponent(
              accessToken
            )}`
          );
          const clientJson: any = await clientResp.json();
          console.log(
            `[WA PHONE NUMBERS] client_whatsapp_business_accounts (biz ${bizId}) =>`,
            JSON.stringify(clientJson, null, 2)
          );

          const clientWabas: any[] = Array.isArray(clientJson?.data)
            ? clientJson.data
            : [];

          for (const w of clientWabas) {
            const wabaId = w.id as string;

            const phoneResp = await fetch(
              `https://graph.facebook.com/v18.0/${encodeURIComponent(
                wabaId
              )}/phone_numbers?access_token=${encodeURIComponent(accessToken)}`
            );
            const phoneData: any = await phoneResp.json();

            console.log(
              `[WA PHONE NUMBERS] /${wabaId}/phone_numbers (client) =>`,
              JSON.stringify(phoneData, null, 2)
            );

            const phone_numbers: any[] = Array.isArray(phoneData?.data)
              ? phoneData.data
              : [];

            if (phone_numbers.length) {
              accounts.push({
                business_id: bizId,
                business_name: bizName,
                waba_id: wabaId,
                waba_type: "client",
                phone_numbers: phone_numbers.map((p: any) => ({
                  phone_number_id: p.id,
                  display_phone_number: p.display_phone_number,
                  verified_name: p.verified_name,
                })),
              });
            }
          }
        } catch (clientErr) {
          console.warn(
            `[WA PHONE NUMBERS] Error en client_whatsapp_business_accounts (biz ${bizId}):`,
            clientErr
          );
        }
      }

      if (!accounts.length) {
        console.warn("[WA PHONE NUMBERS] No se encontraron WABAs con números");
        return res.json({ accounts: [], status: "no_waba" });
      }

      // ❗ SOLO devolvemos; NO guardamos nada todavía
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
        WHERE id = $4
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
