// src/routes/meta/whatsapp-onboard.ts
import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = Router();

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;

if (!META_APP_ID || !META_APP_SECRET) {
  console.warn(
    "⚠️ META_APP_ID o META_APP_SECRET no están definidos. El onboarding de WhatsApp no funcionará correctamente."
  );
}

// POST  /api/meta/whatsapp/onboard-complete
router.post(
  "/whatsapp/onboard-complete",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const tenantId = user?.tenant_id;

      if (!tenantId) {
        return res.status(401).json({ error: "Tenant no encontrado en sesión" });
      }

      const { code } = req.body as { code?: string };

      if (!code) {
        return res
          .status(400)
          .json({ error: "No llegó el 'code' de Meta en la petición" });
      }

      console.log("🔁 [META WA] /onboard-complete code recibido:", {
        tenantId,
        code,
      });

      if (!META_APP_ID || !META_APP_SECRET) {
        console.error("❌ Faltan META_APP_ID o META_APP_SECRET en env");
        return res
          .status(500)
          .json({ error: "Configuración de Meta incompleta en el servidor" });
      }

      // 1) Intercambiar el code por un access_token de larga duración
      const params = new URLSearchParams({
        client_id: META_APP_ID,
        client_secret: META_APP_SECRET,
        code,
      });

      const tokenUrl = `https://graph.facebook.com/v20.0/oauth/access_token?${params.toString()}`;

      const tokenRes = await fetch(tokenUrl);
      const tokenJson: any = await tokenRes.json().catch(() => ({}));

      console.log("🔑 Respuesta oauth/access_token:", tokenRes.status, tokenJson);

      if (!tokenRes.ok || !tokenJson.access_token) {
        return res.status(500).json({
          error: "No se pudo obtener access_token de Meta",
          details: tokenJson,
        });
      }

      const access_token = tokenJson.access_token as string;

      // 2) (Opcional) Aquí podrías llamar a debug_token o a otros endpoints
      //    para obtener waba_id y phone_number_id. De momento marcamos conectado.

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
        [access_token, tenantId]
      );

      console.log("✅ WhatsApp marcado como conectado para tenant", tenantId);

      return res.json({
        success: true,
        whatsapp_connected: true,
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
