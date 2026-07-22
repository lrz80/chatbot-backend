// src/routes/stats-kpis.ts

import { Router, Response } from "express";
import pool from "../lib/db";
import {
  authenticateUser,
  AuthenticatedRequest,
} from "../middleware/auth";

const router: Router = Router();

const ALLOWED_CHANNELS = new Set([
  "whatsapp",
  "voice",
  "facebook",
  "instagram",
]);

function normalizeChannel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  if (!normalized || normalized === "todos") {
    return null;
  }

  return ALLOWED_CHANNELS.has(normalized)
    ? normalized
    : null;
}

router.get(
  "/kpis",
  authenticateUser,
  async (
    req: AuthenticatedRequest,
    res: Response
  ) => {
    const tenantId = req.user?.tenant_id;

    if (!tenantId) {
      return res.status(403).json({
        error: "Tenant no disponible",
      });
    }

    const requestedChannel = req.query.canal;
    const canal = normalizeChannel(requestedChannel);

    if (
      typeof requestedChannel === "string" &&
      requestedChannel.trim() &&
      requestedChannel !== "todos" &&
      !canal
    ) {
      return res.status(400).json({
        error: "Canal inválido",
      });
    }

    try {
      const generalParams: unknown[] = [tenantId];

      let generalChannelCondition = "";

      if (canal) {
        generalParams.push(canal);
        generalChannelCondition = `
          AND canal = $${generalParams.length}
        `;
      }

      const generalStats = await pool.query(
        `
          SELECT
            COUNT(DISTINCT message_id)::int AS total,
            COUNT(
              DISTINCT NULLIF(
                TRIM(from_number),
                ''
              )
            )::int AS unicos
          FROM messages
          WHERE tenant_id = $1
            AND role IN ('user', 'assistant')
            ${generalChannelCondition}
        `,
        generalParams
      );

      const peakParams: unknown[] = [tenantId];

      let peakChannelCondition = `
        AND canal IN (
          'whatsapp',
          'facebook',
          'instagram',
          'voice',
          'voz'
        )
      `;

      if (canal) {
        peakParams.push(canal);

        peakChannelCondition = `
          AND (
            canal = $${peakParams.length}
            OR (
              $${peakParams.length} = 'voice'
              AND canal = 'voz'
            )
          )
        `;
      }

      const horaPicoRes = await pool.query(
        `
          SELECT
            EXTRACT(HOUR FROM timestamp)::int AS hora,
            COUNT(DISTINCT message_id)::int AS total
          FROM messages
          WHERE tenant_id = $1
            AND role = 'user'
            ${peakChannelCondition}
            AND timestamp >= NOW() - INTERVAL '7 days'
          GROUP BY hora
          ORDER BY total DESC, hora ASC
          LIMIT 1
        `,
        peakParams
      );

      const salesParams: unknown[] = [tenantId];

      let salesChannelCondition = "";

      if (canal) {
        salesParams.push(canal);

        salesChannelCondition = `
          AND canal = $${salesParams.length}
        `;
      }

      const ventasRes = await pool.query(
        `
          SELECT
            COUNT(DISTINCT message_id)::int AS intenciones
          FROM sales_intelligence
          WHERE tenant_id = $1
            ${salesChannelCondition}
            AND LOWER(intencion) IN (
              'comprar',
              'pagar',
              'precio',
              'reservar',
              'agendar',
              'confirmar',
              'suscribirme'
            )
            AND nivel_interes >= 2
        `,
        salesParams
      );

      const total =
        Number(generalStats.rows[0]?.total) || 0;

      const unicos =
        Number(generalStats.rows[0]?.unicos) || 0;

      const horaPicoRaw =
        horaPicoRes.rows[0]?.hora;

      const hora_pico =
        horaPicoRaw === null ||
        horaPicoRaw === undefined
          ? null
          : Number(horaPicoRaw);

      const intenciones_venta =
        Number(ventasRes.rows[0]?.intenciones) || 0;

      return res.status(200).json({
        total,
        unicos,
        hora_pico,
        intenciones_venta,
      });
    } catch (error) {
      console.error(
        "❌ Error en /api/stats/kpis:",
        {
          tenantId,
          canal,
          error,
        }
      );

      return res.status(500).json({
        error: "Error interno del servidor",
      });
    }
  }
);

export default router;