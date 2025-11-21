// src/routes/meta/whatsapp-onboard.ts
import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";
import fetch from "node-fetch"; // o usa global fetch si ya lo tienes

const router = Router();

const META_APP_ID = process.env.META_APP_ID!;
const META_APP_SECRET = process.env.META_APP_SECRET!;
// Debe ser exactamente el mismo redirect_uri que usas en el botón y en Meta
const META_WHATSAPP_REDIRECT_URI =
  "https://www.aamy.ai/meta/whatsapp-redirect";

// POST  /api/meta/whatsapp/onboard-complete
router.post(
  "/whatsapp/onboard-complete",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const tenantId = user?.tenant_id;

      if (!tenantId) {
        return res
          .status(401)
          .json({ error: "Tenant no encontrado en sesión" });
      }

      const { code, state } = req.body as { code?: string; state?: string };

      console.log("📥 /whatsapp/onboard-complete body:", { code, state });

      if (!code) {
        return res
          .status(400)
          .json({ error: "No se recibió el código de autorización (code)." });
      }

      // 1) Intercambiar el code por un access token de usuario
      const tokenUrl = new URL(
        "https://graph.facebook.com/v20.0/oauth/access_token"
      );
      tokenUrl.searchParams.set("client_id", META_APP_ID);
      tokenUrl.searchParams.set("redirect_uri", META_WHATSAPP_REDIRECT_URI);
      tokenUrl.searchParams.set("client_secret", META_APP_SECRET);
      tokenUrl.searchParams.set("code", code);

      const tokenRes = await fetch(tokenUrl.toString(), {
        method: "GET",
      });

      const tokenJson = (await tokenRes.json()) as any;
      console.log("🔑 tokenJson:", tokenJson);

      if (!tokenRes.ok || !tokenJson.access_token) {
        return res.status(500).json({
          error:
            "No se pudo obtener el access_token de Meta. Revisa APP_ID/SECRET y redirect_uri.",
          meta: tokenJson,
        });
      }

      const userAccessToken = tokenJson.access_token as string;

      // 2) Obtener la WABA asociada al usuario (primer WABA)
      const wabaRes = await fetch(
        `https://graph.facebook.com/v20.0/me/whatsapp_business_accounts?access_token=${encodeURIComponent(
          userAccessToken
        )}`
      );
      const wabaJson = (await wabaRes.json()) as any;
      console.log("🏢 wabaJson:", wabaJson);

      if (!wabaRes.ok || !Array.isArray(wabaJson.data) || !wabaJson.data[0]) {
        return res.status(500).json({
          error:
            "No se encontró ninguna cuenta de WhatsApp Business asociada a este login.",
          meta: wabaJson,
        });
      }

      const wabaId = wabaJson.data[0].id as string;

      // 3) Obtener los números de teléfono de esa WABA
      const phonesRes = await fetch(
        `https://graph.facebook.com/v20.0/${wabaId}/phone_numbers?access_token=${encodeURIComponent(
          userAccessToken
        )}`
      );
      const phonesJson = (await phonesRes.json()) as any;
      console.log("📞 phonesJson:", phonesJson);

      if (
        !phonesRes.ok ||
        !Array.isArray(phonesJson.data) ||
        !phonesJson.data[0]
      ) {
        return res.status(500).json({
          error:
            "No se encontró ningún número de WhatsApp asociado a la WABA seleccionada.",
          meta: phonesJson,
        });
      }

      const phone = phonesJson.data[0];
      const phoneNumberId = phone.id as string;
      const displayPhoneNumber =
        (phone.display_phone_number as string) || null;

      // 4) Guardar en tu tabla tenants con las columnas reales
      await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_business_id      = $1,
          whatsapp_phone_number_id  = $2,
          whatsapp_phone_number     = $3,
          whatsapp_access_token     = $4,
          whatsapp_status           = 'connected',
          whatsapp_connected        = TRUE,
          whatsapp_connected_at     = NOW(),
          updated_at                = NOW()
        WHERE id = $5
      `,
        [
          wabaId,
          phoneNumberId,
          displayPhoneNumber,
          userAccessToken,
          tenantId,
        ]
      );

      console.log("✅ WhatsApp conectado para tenant", tenantId, {
        wabaId,
        phoneNumberId,
        displayPhoneNumber,
      });

      return res.json({
        success: true,
        wabaId,
        phoneNumberId,
        displayPhoneNumber,
      });
    } catch (err) {
      console.error("❌ Error en /whatsapp/onboard-complete:", err);
      return res
        .status(500)
        .json({ error: "Error interno guardando datos de WhatsApp" });
    }
  }
);

export default router;
