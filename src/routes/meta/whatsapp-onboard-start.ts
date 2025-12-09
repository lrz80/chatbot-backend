// src/routes/meta/whatsapp-onboard-start.ts
import express, { Request, Response } from "express";
import { authenticateUser } from "../../middleware/auth";
import jwt from "jsonwebtoken";

const router = express.Router();

// ID de la app (ya lo tienes en env)
const APP_ID = process.env.META_APP_ID;

// CONFIG_ID del registro insertado (sácalo del panel de Meta y ponlo en env)
const EMBEDDED_SIGNUP_CONFIG_ID =
  process.env.META_EMBEDDED_SIGNUP_CONFIG_ID;

// URL base que ves en "Tu página de destino del registro insertado alojada por Meta"
const EMBEDDED_SIGNUP_BASE_URL =
  "https://business.facebook.com/messaging/whatsapp/onboard/";

/**
 * POST /api/meta/whatsapp-onboard/start
 *
 * Devuelve la URL del REGISTRO INSERTADO de WhatsApp (Embedded Signup)
 * para que el frontend la abra en popup o redirección.
 */
router.post(
  "/start",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const tenantId = user?.tenant_id as string | undefined;

      if (!tenantId) {
        console.error(
          "[WA EMBEDDED START] Falta tenant_id en el token del usuario."
        );
        return res.status(401).json({
          error: "No autenticado: falta tenant_id en el token.",
        });
      }

      if (!APP_ID) {
        console.error("[WA EMBEDDED START] Falta META_APP_ID en env.");
        return res.status(500).json({
          error: "Configuración del servidor incompleta (META_APP_ID).",
        });
      }

      if (!EMBEDDED_SIGNUP_CONFIG_ID) {
        console.error(
          "[WA EMBEDDED START] Falta META_WHATSAPP_EMBEDDED_CONFIG_ID en env."
        );
        return res.status(500).json({
          error:
            "Configuración del servidor incompleta (META_WHATSAPP_EMBEDDED_CONFIG_ID).",
        });
      }

      // Opcional pero recomendado: state firmado con tenantId
      const state = jwt.sign(
        { tenantId },
        process.env.JWT_SECRET || "secret-key",
        { expiresIn: "30m" }
      );

      const url =
        EMBEDDED_SIGNUP_BASE_URL +
        `?app_id=${encodeURIComponent(APP_ID)}` +
        `&config_id=${encodeURIComponent(EMBEDDED_SIGNUP_CONFIG_ID)}` +
        `&state=${encodeURIComponent(state)}`;

      console.log("[WA EMBEDDED START] URL Embedded Signup generada:", {
        url,
        tenant_id: tenantId,
        email: user?.email,
      });

      return res.json({ url });
    } catch (err) {
      console.error("[WA EMBEDDED START] Error general:", err);
      return res.status(500).json({
        error: "Error interno iniciando el registro insertado de WhatsApp.",
      });
    }
  }
);

export default router;
