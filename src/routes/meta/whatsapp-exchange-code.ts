// src/routes/meta/whatsapp-exchange-code.ts

import express, { Request, Response } from "express";
import jwt from "jsonwebtoken";

import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();

const GRAPH_VERSION =
  process.env.META_GRAPH_VERSION || "v26.0";

const META_APP_ID =
  process.env.META_APP_ID ||
  process.env.NEXT_PUBLIC_META_APP_ID ||
  "";

const META_APP_SECRET =
  process.env.META_APP_SECRET || "";

const JWT_SECRET =
  process.env.JWT_SECRET || "";

type EmbeddedSignupStatePayload = {
  tenantId?: string;
  purpose?: string;
  iat?: number;
  exp?: number;
};

router.post(
  "/whatsapp/exchange-code",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const authenticatedTenantId: string | undefined =
        (req as any).user?.tenant_id ||
        (req as any).user?.tenantId;

      const { code, state } = req.body || {};

      if (!authenticatedTenantId) {
        return res.status(401).json({
          ok: false,
          error: "No autenticado.",
        });
      }

      if (!code || typeof code !== "string") {
        return res.status(400).json({
          ok: false,
          error: "Falta code de Meta Embedded Signup.",
        });
      }

      if (!state || typeof state !== "string") {
        return res.status(400).json({
          ok: false,
          error: "Falta state de Embedded Signup.",
        });
      }

      if (!META_APP_ID || !META_APP_SECRET) {
        return res.status(500).json({
          ok: false,
          error:
            "Configuración incompleta: falta META_APP_ID o META_APP_SECRET.",
        });
      }

      if (!JWT_SECRET) {
        return res.status(500).json({
          ok: false,
          error:
            "Configuración incompleta: falta JWT_SECRET.",
        });
      }

      /**
       * 1) Validar state.
       *
       * El state fue generado por whatsapp-onboard-start.ts.
       * Evita que un tenant pueda completar el onboarding
       * utilizando un state generado para otro tenant.
       */
      let statePayload: EmbeddedSignupStatePayload;

      try {
        statePayload = jwt.verify(
          state,
          JWT_SECRET
        ) as EmbeddedSignupStatePayload;
      } catch (error) {
        console.error(
          "[WA EXCHANGE CODE] state inválido:",
          error
        );

        return res.status(400).json({
          ok: false,
          error:
            "El estado de Embedded Signup es inválido o expiró.",
        });
      }

      if (
        !statePayload?.tenantId ||
        String(statePayload.tenantId) !==
          String(authenticatedTenantId)
      ) {
        return res.status(403).json({
          ok: false,
          error:
            "El estado de Embedded Signup no corresponde a este tenant.",
        });
      }

      if (
        statePayload?.purpose !==
        "whatsapp_embedded_signup"
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "El state recibido no corresponde al onboarding de WhatsApp.",
        });
      }

      console.log("[WA EXCHANGE CODE] Exchange iniciado:", {
        tenantId: authenticatedTenantId,
        graphVersion: GRAPH_VERSION,
      });

      /**
       * 2) Exchange del token code por business token.
       */
      const tokenUrl =
        `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token` +
        `?client_id=${encodeURIComponent(META_APP_ID)}` +
        `&client_secret=${encodeURIComponent(
          META_APP_SECRET
        )}` +
        `&code=${encodeURIComponent(code)}`;

      const tokenRes = await fetch(tokenUrl, {
        method: "GET",
      });

      const tokenJson: any = await tokenRes
        .json()
        .catch(() => ({}));

      if (!tokenRes.ok) {
        console.error(
          "[WA EXCHANGE CODE] Meta token exchange falló:",
          tokenJson
        );

        return res.status(502).json({
          ok: false,
          error:
            "Meta rechazó el intercambio del código de autorización.",
          detail: tokenJson,
        });
      }

      const accessToken =
        typeof tokenJson?.access_token === "string"
          ? tokenJson.access_token.trim()
          : "";

      const expiresIn =
        typeof tokenJson?.expires_in === "number"
          ? tokenJson.expires_in
          : null;

      if (!accessToken) {
        console.error(
          "[WA EXCHANGE CODE] Meta no devolvió access_token:",
          tokenJson
        );

        return res.status(502).json({
          ok: false,
          error:
            "Meta no devolvió access_token.",
          detail: tokenJson,
        });
      }

      /**
       * 3) Guardar token.
       *
       * Todavía NO marcamos connected aquí porque falta
       * confirmar WABA + phone_number_id en onboard-complete.
       */
      const update = await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_access_token = $1,
          whatsapp_status = 'pending_complete',
          whatsapp_connected = FALSE,
          whatsapp_connected_at = NULL,
          updated_at = NOW()
        WHERE id::text = $2
        RETURNING id
        `,
        [
          accessToken,
          authenticatedTenantId,
        ]
      );

      if (!update.rowCount) {
        console.error(
          "[WA EXCHANGE CODE] Tenant no encontrado:",
          authenticatedTenantId
        );

        return res.status(404).json({
          ok: false,
          error:
            "Tenant no encontrado al guardar token de WhatsApp.",
        });
      }

      console.log(
        "[WA EXCHANGE CODE] Token guardado correctamente:",
        {
          tenantId: authenticatedTenantId,
          expiresIn,
        }
      );

      return res.json({
        ok: true,
        status: "token_saved_pending_complete",
        expiresIn,
      });
    } catch (error: any) {
      console.error(
        "[WA EXCHANGE CODE] Error inesperado:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Error interno intercambiando el código de WhatsApp.",
      });
    }
  }
);

export default router;