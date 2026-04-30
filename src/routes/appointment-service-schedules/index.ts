//src/routes/appointment-service-schedules/index.ts
import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { getServiceSchedules } from "../../lib/appointments/getServiceSchedules";
import { buildServiceSchedulesEditor } from "../../lib/appointments/buildServiceSchedulesEditor";

const router = Router();

type ScheduleInputItem = {
  service_name: string;
  day_of_week: number;
  times: string[];
};

function normalizeTime(value: string): string {
  const raw = String(value || "").trim();
  const [hh = "", mm = "00"] = raw.split(":");
  return `${hh.padStart(2, "0")}:${mm.padStart(2, "0")}:00`;
}

function isValidDayOfWeek(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 6;
}

function isValidHHMM(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value || "").trim());
}

router.get("/", async (req: Request, res: Response) => {
  try {
    const tenantId =
      String(req.query.tenant_id || "").trim() ||
      String((req as any).tenant?.id || "").trim();

    if (!tenantId) {
      return res.status(400).json({ error: "tenant_id_required" });
    }

    const rows = await getServiceSchedules({
      tenantId,
      channel: "voice",
    });

    const editorData = buildServiceSchedulesEditor(rows);

    return res.json({
      ok: true,
      items: editorData,
    });
  } catch (error) {
    console.error("[GET /appointment-service-schedules] error:", error);
    return res.status(500).json({ error: "internal_error" });
  }
});

router.post("/", async (req: Request, res: Response) => {
  const client = await pool.connect();

  try {
    const tenantId =
      String(req.body?.tenant_id || "").trim() ||
      String((req as any).tenant?.id || "").trim();

    const items = Array.isArray(req.body?.items) ? req.body.items : null;

    if (!tenantId) {
      return res.status(400).json({ error: "tenant_id_required" });
    }

    if (!items) {
      return res.status(400).json({ error: "items_required" });
    }

    const parsedItems: ScheduleInputItem[] = [];

    for (const rawItem of items) {
      const serviceName = String(rawItem?.service_name || "").trim();
      const dayOfWeek = Number(rawItem?.day_of_week);
      const times = Array.isArray(rawItem?.times)
        ? rawItem.times.map((t: unknown) => String(t || "").trim()).filter(Boolean)
        : [];

      if (!serviceName) {
        return res.status(400).json({ error: "invalid_service_name" });
      }

      if (!isValidDayOfWeek(dayOfWeek)) {
        return res.status(400).json({ error: "invalid_day_of_week" });
      }

      for (const time of times) {
        if (!isValidHHMM(time)) {
          return res.status(400).json({ error: `invalid_time_format:${time}` });
        }
      }

      parsedItems.push({
        service_name: serviceName,
        day_of_week: dayOfWeek,
        times,
      });
    }

    await client.query("BEGIN");

    await client.query(
      `
      DELETE FROM appointment_service_schedules
      WHERE tenant_id = $1
        AND channel = 'voice'
      `,
      [tenantId]
    );

    for (const item of parsedItems) {
      for (const time of item.times) {
        await client.query(
          `
          INSERT INTO appointment_service_schedules (
            tenant_id,
            service_name,
            day_of_week,
            start_time,
            enabled,
            channel,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, true, 'voice', NOW(), NOW())
          `,
          [
            tenantId,
            item.service_name,
            item.day_of_week,
            normalizeTime(time),
          ]
        );
      }
    }

    await client.query("COMMIT");

    const rows = await getServiceSchedules({
      tenantId,
      channel: "voice",
    });

    const editorData = buildServiceSchedulesEditor(rows);

    return res.json({
      ok: true,
      items: editorData,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[POST /appointment-service-schedules] error:", error);
    return res.status(500).json({ error: "internal_error" });
  } finally {
    client.release();
  }
});

export default router;