// src/routes/reports/monthly-summary.ts
import { Router, Request, Response } from "express";
import PDFDocument = require("pdfkit");
import { authenticateUser } from "../../middleware/auth";
import pool from "../../lib/db";
import { DateTime } from "luxon";
import { getBusinessHours } from "../../lib/appointments/booking/db";
import { isWithinBusinessHours } from "../../lib/appointments/booking/time";

const router = Router();

type ParsedMonth = {
  start: string;
  end: string;
  label: string;
};

type MonthlySummary = {
  month: string;
  totalMessages: number;
  uniqueCustomers: number;
  estimatedTimeSavedMinutes: number;
  estimatedTimeSavedHours: number;
  conversationsByChannel: Record<string, number>;
  voice: {
    calls: number;
    messages: number;
    seconds: number;
    minutes: number;
    estimatedFromMessages: boolean;
    afterHoursCalls: number;
    afterHoursAvailable: boolean;
  };
  bookings: {
    started: number;
    startedEstimatedFromAppointments: boolean;
    appointmentsCreated: number;
    confirmed: number;
    conversionRate: number;
  };
  topIntentions: Array<{
    intention: string;
    total: number;
  }>;
  followUpNeeded: number;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function parseMonth(value: unknown): ParsedMonth | null {
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

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function calculateEstimatedTimeSavedMinutes(params: {
  totalMessages: number;
  voiceCalls: number;
  bookingsConfirmed: number;
}): number {
  /**
   * Conservative estimate:
   * - Each handled message saves ~45 seconds.
   * - Each handled voice call saves ~3 minutes.
   * - Each confirmed booking saves ~4 minutes of manual back-and-forth.
   */
  const messageMinutes = params.totalMessages * 0.75;
  const voiceMinutes = params.voiceCalls * 3;
  const bookingMinutes = params.bookingsConfirmed * 4;

  return roundOne(messageMinutes + voiceMinutes + bookingMinutes);
}

async function getTenantReportContext(tenantId: string): Promise<{
  tenantName: string;
  timeZone: string;
}> {
  const { rows } = await pool.query(
    `
    SELECT
      name,
      settings
    FROM tenants
    WHERE id = $1
    LIMIT 1
    `,
    [tenantId]
  );

  const row = rows[0] || {};
  const tenantName = clean(row.name) || "Business";

  const configuredTimeZone =
    clean(row.settings?.timezone) ||
    clean(row.settings?.timeZone) ||
    clean(row.settings?.booking?.timezone) ||
    clean(row.settings?.calendar?.timezone);

  return {
    tenantName,
    timeZone: configuredTimeZone || "America/New_York",
  };
}

async function countAfterHoursVoiceCalls(params: {
  tenantId: string;
  month: ParsedMonth;
  timeZone: string;
}): Promise<{
  afterHoursCalls: number;
  afterHoursAvailable: boolean;
}> {
  const { tenantId, month, timeZone } = params;

  const hours = await getBusinessHours(tenantId);

  if (!hours) {
    return {
      afterHoursCalls: 0,
      afterHoursAvailable: false,
    };
  }

  const { rows } = await pool.query(
    `
    SELECT
      call_sid,
      started_at,
      ended_at,
      duration_sec
    FROM voice_calls
    WHERE tenant_id = $1
      AND started_at >= $2::timestamptz
      AND started_at < $3::timestamptz
      AND NULLIF(TRIM(call_sid), '') IS NOT NULL
    `,
    [tenantId, month.start, month.end]
  );

  let afterHoursCalls = 0;

  for (const row of rows) {
    const startedAt = row.started_at;

    if (!startedAt) continue;

    const start = DateTime.fromJSDate(new Date(startedAt), {
      zone: timeZone,
    });

    if (!start.isValid) continue;

    const durationSec = toNumber(row.duration_sec);
    const end = start.plus({
      seconds: durationSec > 0 ? durationSec : 60,
    });

    const check = isWithinBusinessHours({
      hours,
      startISO: start.toISO() || "",
      endISO: end.toISO() || "",
      timeZone,
    });

    if (!check.ok) {
      afterHoursCalls += 1;
    }
  }

  return {
    afterHoursCalls,
    afterHoursAvailable: true,
  };
}

function formatMonthLabel(month: string): string {
  const [yearRaw, monthRaw] = month.split("-");
  const year = Number(yearRaw);
  const monthIndex = Number(monthRaw) - 1;

  const date = new Date(year, monthIndex, 1);

  return date.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

async function buildMonthlySummary(params: {
  tenantId: string;
  month: ParsedMonth;
}): Promise<MonthlySummary> {
  const { tenantId, month } = params;

  const tenantContext = await getTenantReportContext(tenantId);

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
        COUNT(DISTINCT NULLIF(TRIM(contacto), ''))::int AS follow_up_needed
      FROM sales_intelligence
      WHERE tenant_id = $1
        AND fecha >= $2::timestamp
        AND fecha < $3::timestamp
        AND NULLIF(TRIM(contacto), '') IS NOT NULL
      `,
      [tenantId, month.start, month.end]
    ),
  ]);

  const totalMessages = toNumber(messagesSummary.rows[0]?.total_messages);
  const uniqueCustomers = toNumber(messagesSummary.rows[0]?.unique_customers);

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

  const rawBookingsStarted = toNumber(
    bookingsStartedSummary.rows[0]?.bookings_started
  );

  const appointmentsCreated = toNumber(
    appointmentsSummary.rows[0]?.total_appointments
  );

  const bookingsConfirmed = toNumber(
    appointmentsSummary.rows[0]?.successful_appointments
  );

  const estimatedTimeSavedMinutes = calculateEstimatedTimeSavedMinutes({
    totalMessages,
    voiceCalls,
    bookingsConfirmed,
  });

  const estimatedTimeSavedHours = roundOne(estimatedTimeSavedMinutes / 60);

  const afterHoursVoice = await countAfterHoursVoiceCalls({
    tenantId,
    month,
    timeZone: tenantContext.timeZone,
  });

  const bookingsStarted =
    rawBookingsStarted > 0 ? rawBookingsStarted : appointmentsCreated;

  const bookingsStartedEstimated =
    rawBookingsStarted === 0 && appointmentsCreated > 0;

  const bookingConversionRate =
    bookingsStarted > 0
      ? Math.round((bookingsConfirmed / bookingsStarted) * 1000) / 10
      : 0;

  const topIntentions = topIntentionsRows.rows.map((row) => ({
    intention: row.intention,
    total: toNumber(row.total),
  }));

  const followUpNeeded = toNumber(followUpSummary.rows[0]?.follow_up_needed);

  return {
    month: month.label,
    totalMessages,
    uniqueCustomers,
    estimatedTimeSavedMinutes,
    estimatedTimeSavedHours,
    conversationsByChannel,
    voice: {
      calls: voiceCalls,
      messages: voiceMessages,
      seconds: voiceSeconds,
      minutes: voiceMinutes,
      estimatedFromMessages: voiceEstimatedFromMessages,
      afterHoursCalls: afterHoursVoice.afterHoursCalls,
      afterHoursAvailable: afterHoursVoice.afterHoursAvailable,
    },
    bookings: {
      started: bookingsStarted,
      startedEstimatedFromAppointments: bookingsStartedEstimated,
      appointmentsCreated,
      confirmed: bookingsConfirmed,
      conversionRate: bookingConversionRate,
    },
    topIntentions,
    followUpNeeded,
  };
}

function drawMetricCard(params: {
  doc: PDFKit.PDFDocument;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  value: string;
  subtitle?: string;
}) {
  const { doc, x, y, w, h, title, value, subtitle } = params;

  doc
    .roundedRect(x, y, w, h, 14)
    .fillAndStroke("#FFFFFF", "#E5E7EB");

  doc
    .fillColor("#6B7280")
    .fontSize(9)
    .font("Helvetica")
    .text(title, x + 16, y + 16, {
      width: w - 32,
    });

  doc
    .fillColor("#111827")
    .fontSize(24)
    .font("Helvetica-Bold")
    .text(value, x + 16, y + 36, {
      width: w - 32,
    });

  if (subtitle) {
    doc
      .fillColor("#6B7280")
      .fontSize(8)
      .font("Helvetica")
      .text(subtitle, x + 16, y + 70, {
        width: w - 32,
        lineGap: 1,
      });
  }
}

function drawSectionTitle(doc: PDFKit.PDFDocument, title: string, x: number, y: number) {
  doc
    .fillColor("#111827")
    .fontSize(15)
    .font("Helvetica-Bold")
    .text(title, x, y);
}

function drawChannelRow(params: {
  doc: PDFKit.PDFDocument;
  label: string;
  value: number;
  max: number;
  x: number;
  y: number;
  w: number;
}) {
  const { doc, label, value, max, x, y, w } = params;
  const percent = max > 0 ? Math.min(1, value / max) : 0;

  doc
    .fillColor("#374151")
    .fontSize(10)
    .font("Helvetica")
    .text(label, x, y);

  doc
    .fillColor("#111827")
    .fontSize(10)
    .font("Helvetica-Bold")
    .text(String(value), x + w - 40, y, {
      width: 40,
      align: "right",
    });

  doc
    .roundedRect(x, y + 18, w, 7, 4)
    .fill("#E5E7EB");

  doc
    .roundedRect(x, y + 18, Math.max(7, w * percent), 7, 4)
    .fill("#4C1D95");
}

function generateMonthlyReportPdf(params: {
  res: Response;
  summary: MonthlySummary;
  tenantName: string;
}) {
  const { res, summary, tenantName } = params;

  const doc = new PDFDocument({
    size: "LETTER",
    margin: 40,
    info: {
      Title: `Aamy Monthly Report - ${summary.month}`,
      Author: "Aamy AI",
      Subject: "Monthly performance report",
    },
  });

  const filename = `aamy-monthly-report-${summary.month}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`
  );

  doc.pipe(res);

  const pageWidth = doc.page.width;
  const margin = 40;
  const contentWidth = pageWidth - margin * 2;

  // Header background
  doc
    .roundedRect(margin, 34, contentWidth, 104, 18)
    .fill("#21002F");

  doc
    .fillColor("#FFFFFF")
    .font("Helvetica-Bold")
    .fontSize(26)
    .text("Aamy Monthly Report", margin + 24, 58);

  doc
    .fillColor("#D8B4FE")
    .font("Helvetica")
    .fontSize(12)
    .text(tenantName || "Business report", margin + 24, 92);

  doc
    .fillColor("#E9D5FF")
    .font("Helvetica-Bold")
    .fontSize(14)
    .text(formatMonthLabel(summary.month), margin + 24, 112);

  doc
    .roundedRect(pageWidth - 164, 58, 96, 34, 17)
    .fill("#7E22CE");

  doc
    .fillColor("#FFFFFF")
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(summary.month, pageWidth - 164, 68, {
      width: 96,
      align: "center",
    });

  // Main metric cards
  const y1 = 166;
  const gap = 12;
  const cardW = (contentWidth - gap * 3) / 4;
  const cardH = 104;

  drawMetricCard({
    doc,
    x: margin,
    y: y1,
    w: cardW,
    h: cardH,
    title: "Total messages",
    value: String(summary.totalMessages),
    subtitle: "Customer and assistant messages",
  });

  drawMetricCard({
    doc,
    x: margin + (cardW + gap),
    y: y1,
    w: cardW,
    h: cardH,
    title: "Unique customers",
    value: String(summary.uniqueCustomers),
    subtitle: "Unique contacts detected",
  });

  drawMetricCard({
    doc,
    x: margin + (cardW + gap) * 2,
    y: y1,
    w: cardW,
    h: cardH,
    title: "Voice calls",
    value: String(summary.voice.calls),
    subtitle: summary.voice.estimatedFromMessages
      ? "Estimated from history"
      : "Based on real call records",
  });

  drawMetricCard({
    doc,
    x: margin + (cardW + gap) * 3,
    y: y1,
    w: cardW,
    h: cardH,
    title: "Estimated time saved",
    value: `${summary.estimatedTimeSavedMinutes} min`,
    subtitle:
      summary.estimatedTimeSavedHours >= 1
        ? `${summary.estimatedTimeSavedHours} hours estimated`
        : "Based on messages, calls, and bookings",
  });

  // Bookings section
  const y2 = 304;

  doc
    .roundedRect(margin, y2, contentWidth, 144, 18)
    .fillAndStroke("#FFFFFF", "#E5E7EB");

  drawSectionTitle(doc, "Bookings", margin + 20, y2 + 20);

  doc
    .fillColor("#6B7280")
    .font("Helvetica")
    .fontSize(10)
    .text(
      "Booking activity created by Aamy during this period.",
      margin + 20,
      y2 + 42
    );

  doc
    .roundedRect(pageWidth - 174, y2 + 18, 104, 28, 14)
    .fill("#111827");

  doc
    .fillColor("#FFFFFF")
    .font("Helvetica-Bold")
    .fontSize(10)
    .text(`${summary.bookings.conversionRate}% conversion`, pageWidth - 174, y2 + 27, {
      width: 104,
      align: "center",
    });

  const bookingCardY = y2 + 70;
  const bookingCardW = (contentWidth - 40 - gap * 2) / 3;

  drawMetricCard({
    doc,
    x: margin + 20,
    y: bookingCardY,
    w: bookingCardW,
    h: 58,
    title: "Started",
    value: String(summary.bookings.started),
  });

  drawMetricCard({
    doc,
    x: margin + 20 + bookingCardW + gap,
    y: bookingCardY,
    w: bookingCardW,
    h: 58,
    title: "Created",
    value: String(summary.bookings.appointmentsCreated),
  });

  drawMetricCard({
    doc,
    x: margin + 20 + (bookingCardW + gap) * 2,
    y: bookingCardY,
    w: bookingCardW,
    h: 58,
    title: "Confirmed",
    value: String(summary.bookings.confirmed),
  });

  // Channels and followup
  const y3 = 478;
  const halfW = (contentWidth - 16) / 2;

  doc
    .roundedRect(margin, y3, halfW, 188, 18)
    .fillAndStroke("#FFFFFF", "#E5E7EB");

  drawSectionTitle(doc, "Conversations by channel", margin + 20, y3 + 20);

  const channels = Object.entries(summary.conversationsByChannel);
  const maxChannelValue = Math.max(...channels.map(([, value]) => value), 0);

  let channelY = y3 + 52;
  for (const [channel, value] of channels) {
    drawChannelRow({
      doc,
      label: channel.charAt(0).toUpperCase() + channel.slice(1),
      value,
      max: maxChannelValue,
      x: margin + 20,
      y: channelY,
      w: halfW - 40,
    });

    channelY += 31;
  }

  const rightX = margin + halfW + 16;

  doc
    .roundedRect(rightX, y3, halfW, 188, 18)
    .fillAndStroke("#FFFFFF", "#E5E7EB");

  drawSectionTitle(doc, "Captured leads", rightX + 20, y3 + 20);

  doc
    .fillColor("#6B7280")
    .font("Helvetica")
    .fontSize(10)
    .text(
      "New contacts identified by Aamy during this period.",
      rightX + 20,
      y3 + 44,
      {
        width: halfW - 40,
      }
    );

  doc
    .fillColor("#111827")
    .font("Helvetica-Bold")
    .fontSize(42)
    .text(String(summary.followUpNeeded), rightX + 20, y3 + 92, {
      width: halfW - 40,
      align: "center",
    });

  doc
    .fillColor("#6B7280")
    .font("Helvetica")
    .fontSize(10)
    .text("leads generated this month", rightX + 20, y3 + 138, {
      width: halfW - 40,
      align: "center",
    });

  doc
    .roundedRect(rightX + 28, y3 + 158, halfW - 56, 22, 11)
    .fill("#F3F4F6");

  doc
    .fillColor("#374151")
    .font("Helvetica-Bold")
    .fontSize(9)
    .text(
      summary.voice.afterHoursAvailable
        ? `After-hours calls: ${summary.voice.afterHoursCalls}`
        : "After-hours calls: not available",
      rightX + 28,
      y3 + 165,
      {
        width: halfW - 56,
        align: "center",
      }
    );

  // Footer
  doc
    .moveTo(margin, 720)
    .lineTo(pageWidth - margin, 720)
    .strokeColor("#E5E7EB")
    .stroke();

  doc
    .fillColor("#6B7280")
    .font("Helvetica")
    .fontSize(8)
    .text(
      "Generated by Aamy AI. Metrics may vary depending on integrations, configuration, and available records.",
      margin,
      732,
      {
        width: contentWidth,
        align: "center",
      }
    );

  doc.end();
}

router.get(
  "/monthly-summary",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const tenantId = clean((req as any).user?.tenant_id);

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

      const summary = await buildMonthlySummary({
        tenantId,
        month,
      });

      return res.json(summary);
    } catch (error) {
      console.error("❌ Error generando monthly summary:", error);
      return res.status(500).json({
        error: "Error generando reporte mensual",
      });
    }
  }
);

router.get(
  "/monthly-summary.pdf",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const tenantId = clean((req as any).user?.tenant_id);

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

      const summary = await buildMonthlySummary({
        tenantId,
        month,
      });

      const tenantResult = await pool.query(
        `
        SELECT name
        FROM tenants
        WHERE id = $1
        LIMIT 1
        `,
        [tenantId]
      );

      const tenantName = clean(tenantResult.rows[0]?.name) || "Business";

      generateMonthlyReportPdf({
        res,
        summary,
        tenantName,
      });
    } catch (error) {
      console.error("❌ Error generando monthly summary PDF:", error);
      return res.status(500).json({
        error: "Error generando PDF del reporte mensual",
      });
    }
  }
);

export default router;