// src/routes/meta/whatsapp-onboard-start.ts

import express, { Request, Response } from "express";
import { authenticateUser } from "../../middleware/auth";
import jwt from "jsonwebtoken";

const router = express.Router();

const APP_ID =
  process.env.META_APP_ID ||
  process.env.NEXT_PUBLIC_META_APP_ID ||
  "";

const EMBEDDED_SIGNUP_CONFIG_ID =
  process.env.META_EMBEDDED_SIGNUP_CONFIG_ID || "";

const JWT_SECRET = process.env.JWT_SECRET || "";

router.post(
  "/whatsapp-onboard/start",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;

      const tenantId: string | undefined =
        user?.tenant_id || user?.tenantId;

      if (!tenantId) {
        console.error(
          "[WA EMBEDDED START] Falta tenant_id en el usuario autenticado."
        );

        return res.status(401).json({
          ok: false,
          error: "No autenticado: falta tenant_id.",
        });
      }

      if (!APP_ID) {
        console.error(
          "[WA EMBEDDED START] Falta META_APP_ID."
        );

        return res.status(500).json({
          ok: false,
          error: "Configuración incompleta: falta META_APP_ID.",
        });
      }

      if (!EMBEDDED_SIGNUP_CONFIG_ID) {
        console.error(
          "[WA EMBEDDED START] Falta META_EMBEDDED_SIGNUP_CONFIG_ID."
        );

        return res.status(500).json({
          ok: false,
          error:
            "Configuración incompleta: falta META_EMBEDDED_SIGNUP_CONFIG_ID.",
        });
      }

      if (!JWT_SECRET) {
        console.error(
          "[WA EMBEDDED START] Falta JWT_SECRET."
        );

        return res.status(500).json({
          ok: false,
          error: "Configuración incompleta: falta JWT_SECRET.",
        });
      }

      const state = jwt.sign(
        {
          tenantId,
          purpose: "whatsapp_embedded_signup",
        },
        JWT_SECRET,
        {
          expiresIn: "30m",
        }
      );

      console.log("[WA EMBEDDED START] Configuración preparada:", {
        tenantId,
        appId: APP_ID,
        configId: EMBEDDED_SIGNUP_CONFIG_ID,
        email: user?.email || null,
      });

      return res.json({
        ok: true,

        app_id: APP_ID,

        config_id: EMBEDDED_SIGNUP_CONFIG_ID,

        state,

        embedded_signup_version: "4",
      });
    } catch (err) {
      console.error(
        "[WA EMBEDDED START] Error general:",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Error interno preparando Embedded Signup de WhatsApp.",
      });
    }
  }
);

export default router;