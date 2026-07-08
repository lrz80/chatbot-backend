// src/routes/reports/monthly-summary.ts
import { Router, Request, Response } from "express";
import { authenticateUser } from "../../middleware/auth";
import pool from "../../lib/db";

const router = Router();

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function parseMonth(
  value: unknown
): { start: string; end: string; label: string } | null {
  const raw = clean(value);

  if (!/^\d{4}-\d{2}$/.test(raw)) {
    return null;
  }

  const [yearRaw, monthRaw] = raw.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);

  if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
  if (month < 1 || month > 12) return null;

  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0));

  return {
    start: start.toISOString(),
    end: end.toISOString(),
    label: raw,
  };
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

router.get(
  "/monthly-summary",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const tenantId = (req as any).user?.tenant_id;

      if (!tenantId) {
        return res.status(401).json({ error: "Tenant no autenticado" });
      }

      const month = parseMonth(req.query.month);

      if (!month) {
        return res.status(400).json({
          error:
            "Parámetro month inválido. Usa formato YYYY-MM. Ejemplo: 2026-07",
        });
      }

      const [
        messagesSummary,
        channelRows,
        voiceCallsSummary,
        bookingsStartedSummary,
        appointmentsSummary,
        topIntentionsRows,
        followUpSummary,
      ] = await Promise.all([
        pool.query(
          `
          SELECT
            COUNT(*)::int AS total_messages,
            COUNT(DISTINCT NULLIF(TRIM(from_number), ''))::int AS unique_customers
          FROM messages
          WHERE tenant_id = $1
            AND timestamp >= $2::timestamp
            AND timestamp < $3::timestamp
          `,
          [tenantId, month.start, month.end]
        ),

        pool.query(
          `
          SELECT
            CASE
              WHEN LOWER(COALESCE(canal, '')) LIKE '%whatsapp%'
                OR LOWER(COALESCE(canal, '')) LIKE 'wa%' THEN 'whatsapp'
              WHEN LOWER(COALESCE(canal, '')) LIKE '%facebook%'
                OR LOWER(COALESCE(canal, '')) = 'fb' THEN 'facebook'
              WHEN LOWER(COALESCE(canal, '')) LIKE '%instagram%'
                OR LOWER(COALESCE(canal, '')) = 'ig' THEN 'instagram'
              WHEN LOWER(COALESCE(canal, '')) LIKE '%voz%'
                OR LOWER(COALESCE(canal, '')) LIKE '%voice%'
                OR LOWER(COALESCE(canal, '')) LIKE '%call%'
                OR LOWER(COALESCE(canal, '')) LIKE '%llamada%'
                OR LOWER(COALESCE(canal, '')) LIKE '%telefono%' THEN 'voice'
              ELSE COALESCE(NULLIF(TRIM(LOWER(canal)), ''), 'unknown')
            END AS channel,
            COUNT(*)::int AS total
          FROM messages
          WHERE tenant_id = $1
            AND timestamp >= $2::timestamp
            AND timestamp < $3::timestamp
          GROUP BY 1
          ORDER BY total DESC
          `,
          [tenantId, month.start, month.end]
        ),

        pool.query(
          `
          WITH voice_from_calls AS (
            SELECT
              COUNT(*)::int AS total_calls,
              COALESCE(SUM(duration_sec), 0)::int AS total_seconds
            FROM voice_calls
            WHERE tenant_id = $1
              AND started_at >= $2::timestamptz
              AND started_at < $3::timestamptz
          ),
          voice_from_messages AS (
            SELECT
              COUNT(*)::int AS voice_messages,
              COUNT(DISTINCT split_part(message_id, ':', 2))::int AS estimated_calls
            FROM messages
            WHERE tenant_id = $1
              AND timestamp >= $2::timestamp
              AND timestamp < $3::timestamp
              AND (
                LOWER(COALESCE(canal, '')) LIKE '%voice%'
                OR LOWER(COALESCE(canal, '')) LIKE '%voz%'
                OR LOWER(COALESCE(canal, '')) LIKE '%call%'
                OR LOWER(COALESCE(canal, '')) LIKE '%llamada%'
                OR LOWER(COALESCE(canal, '')) LIKE '%telefono%'
              )
              AND COALESCE(message_id, '') LIKE 'voice:%'
          )
          SELECT
            CASE
              WHEN voice_from_calls.total_calls > 0
                THEN voice_from_calls.total_calls
              ELSE voice_from_messages.estimated_calls
            END::int AS total_calls,

            voice_from_calls.total_seconds::int AS total_seconds,
            voice_from_messages.voice_messages::int AS voice_messages,

            CASE
              WHEN voice_from_calls.total_calls > 0 THEN false
              ELSE true
            END AS estimated_from_messages
          FROM voice_from_calls, voice_from_messages
          `,
          [tenantId, month.start, month.end]
        ),

        pool.query(
          `
          SELECT
            COUNT(*)::int AS bookings_started
          FROM booking_sessions
          WHERE tenant_id = $1
            AND created_at >= $2::timestamptz
            AND created_at < $3::timestamptz
          `,
          [tenantId, month.start, month.end]
        ),

        pool.query(
          `
          SELECT
            COUNT(*)::int AS total_appointments,
            COUNT(*) FILTER (
              WHERE LOWER(COALESCE(status, '')) NOT IN (
                'cancelled',
                'canceled',
                'failed',
                'error'
              )
              AND error_reason IS NULL
            )::int AS successful_appointments
          FROM appointments
          WHERE tenant_id = $1
            AND created_at >= $2::timestamptz
            AND created_at < $3::timestamptz
          `,
          [tenantId, month.start, month.end]
        ),

        pool.query(
          `
          SELECT
            COALESCE(NULLIF(TRIM(intencion), ''), 'Sin clasificar') AS intention,
            COUNT(*)::int AS total
          FROM sales_intelligence
          WHERE tenant_id = $1
            AND fecha >= $2::timestamp
            AND fecha < $3::timestamp
          GROUP BY 1
          ORDER BY total DESC
          LIMIT 5
          `,
          [tenantId, month.start, month.end]
        ),

        pool.query(
          `
          SELECT
            COUNT(*)::int AS follow_up_needed
          FROM sales_intelligence
          WHERE tenant_id = $1
            AND fecha >= $2::timestamp
            AND fecha < $3::timestamp
            AND COALESCE(nivel_interes, 0) >= 4
          `,
          [tenantId, month.start, month.end]
        ),
      ]);

      const totalMessages = toNumber(messagesSummary.rows[0]?.total_messages);
      const uniqueCustomers = toNumber(
        messagesSummary.rows[0]?.unique_customers
      );

      const conversationsByChannel: Record<string, number> = {
        voice: 0,
        whatsapp: 0,
        instagram: 0,
        facebook: 0,
        unknown: 0,
      };

      for (const row of channelRows.rows) {
        const channel = clean(row.channel) || "unknown";
        conversationsByChannel[channel] = toNumber(row.total);
      }

      const voiceCalls = toNumber(voiceCallsSummary.rows[0]?.total_calls);
      const voiceSeconds = toNumber(voiceCallsSummary.rows[0]?.total_seconds);
      const voiceMessages = toNumber(voiceCallsSummary.rows[0]?.voice_messages);
      const voiceEstimatedFromMessages =
        voiceCallsSummary.rows[0]?.estimated_from_messages === true;

      const voiceMinutes = Math.round((voiceSeconds / 60) * 10) / 10;

      const bookingsStarted = toNumber(
        bookingsStartedSummary.rows[0]?.bookings_started
      );
      const appointmentsCreated = toNumber(
        appointmentsSummary.rows[0]?.total_appointments
      );
      const bookingsConfirmed = toNumber(
        appointmentsSummary.rows[0]?.successful_appointments
      );

      const bookingConversionRate =
        bookingsStarted > 0
          ? Math.round((bookingsConfirmed / bookingsStarted) * 1000) / 10
          : 0;

      const topIntentions = topIntentionsRows.rows.map((row) => ({
        intention: row.intention,
        total: toNumber(row.total),
      }));

      const followUpNeeded = toNumber(
        followUpSummary.rows[0]?.follow_up_needed
      );

      return res.json({
        month: month.label,
        totalMessages,
        uniqueCustomers,
        conversationsByChannel,
        voice: {
          calls: voiceCalls,
          messages: voiceMessages,
          seconds: voiceSeconds,
          minutes: voiceMinutes,
          estimatedFromMessages: voiceEstimatedFromMessages,
        },
        bookings: {
          started: bookingsStarted,
          appointmentsCreated,
          confirmed: bookingsConfirmed,
          conversionRate: bookingConversionRate,
        },
        topIntentions,
        followUpNeeded,
      });
    } catch (error) {
      console.error("❌ Error generando monthly summary:", error);
      return res.status(500).json({
        error: "Error generando reporte mensual",
      });
    }
  }
);

export default router;