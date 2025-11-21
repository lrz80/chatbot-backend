// src/routes/meta/whatsapp-onboard.ts
import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = Router();

router.post(
  "/whatsapp/onboard-complete",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const tenantId = user?.tenant_id;

      if (!tenantId) {
        console.error("❌ [META WA] Tenant no encontrado en sesión");
        return res.status(401).json({ error: "Tenant no encontrado en sesión" });
      }

      const { code } = req.body as { code?: string };

      console.log("🔁 [META WA] /whatsapp/onboard-complete body:", req.body);

      if (!code) {
        return res.status(400).json({ error: "No llegó el código 'code' desde Meta" });
      }

      const appId = process.env.META_APP_ID;
      const appSecret = process.env.META_APP_SECRET;
      const redirectUri = process.env.META_WHATSAPP_REDIRECT_URI;

      if (!appId || !appSecret || !redirectUri) {
        console.error("❌ [META WA] Faltan envs META_APP_ID / META_APP_SECRET / META_WHATSAPP_REDIRECT_URI");
        return res.status(500).json({
          error:
            "Configuración de Meta incompleta en el backend. Revisa las variables de entorno.",
        });
      }

      // 1) Intercambiar code -> access_token
      const tokenUrl = new URL("https://graph.facebook.com/v20.0/oauth/access_token");
      tokenUrl.searchParams.set("client_id", appId);
      tokenUrl.searchParams.set("client_secret", appSecret);
      tokenUrl.searchParams.set("redirect_uri", redirectUri);
      tokenUrl.searchParams.set("code", code);

      console.log("🌐 [META WA] Llamando a:", tokenUrl.toString());

      const tokenRes = await fetch(tokenUrl.toString(), { method: "GET" });
      const tokenJson = await tokenRes.json();

      console.log("📦 [META WA] Respuesta access_token:", tokenRes.status, tokenJson);

      if (!tokenRes.ok) {
        return res.status(500).json({
          error: "No se pudo obtener el access_token de Meta. Revisa APP_ID/SECRET y redirect_uri.",
          meta: tokenJson,
        });
      }

      const accessToken = (tokenJson as any).access_token as string | undefined;

      if (!accessToken) {
        return res.status(500).json({
          error: "Meta no devolvió access_token en la respuesta.",
          meta: tokenJson,
        });
      }

      // ⚠️ Paso siguiente: usar accessToken para obtener waba_id, phone_number_id, etc.
      // De momento solo lo guardamos como whatsapp_access_token y marcamos whatsapp_connected=true

      await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_access_token = $1,
          whatsapp_connected    = TRUE,
          whatsapp_connected_at = NOW(),
          updated_at            = NOW()
        WHERE id = $2
      `,
        [accessToken, tenantId]
      );

      console.log("✅ [META WA] Guardado access_token para tenant", tenantId);

      return res.json({
        success: true,
        access_token: accessToken,
        raw: tokenJson,
      });
    } catch (err) {
      console.error("❌ [META WA] Error en /whatsapp/onboard-complete:", err);
      return res
        .status(500)
        .json({ error: "Error interno guardando datos de WhatsApp" });
    }
  }
);

export default router;
