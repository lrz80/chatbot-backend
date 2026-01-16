import { Router, Request, Response } from "express";
import { authenticateUser } from "../middleware/auth";
import { canUseChannel } from "../lib/features";
import pool from "../lib/db";
import { googleFreeBusy, googleCreateEvent } from "../services/googleCalendar";

const router = Router();
router.use(authenticateUser);

function getTenantId(req: Request, res: Response) {
  return (
    (req as any).user?.tenant_id ??
    (res.locals as any)?.tenant_id ??
    (req as any).tenant_id ??
    (req as any).tenantId
  );
}

// POST /api/appointments/google/availability
router.post("/availability", async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req, res);
    if (!tenantId) return res.status(401).json({ error: "unauthorized" });

    const gate = await canUseChannel(tenantId, "google_calendar");
    if (!gate.settings_enabled) return res.status(403).json({ error: "google_calendar_disabled" });

    const { timeMin, timeMax, calendarId } = req.body || {};
    if (!timeMin || !timeMax) return res.status(400).json({ error: "missing_time_range" });

    const fb = await googleFreeBusy({ tenantId, timeMin, timeMax, calendarId: calendarId || "primary" });
    const busy = fb?.calendars?.[calendarId || "primary"]?.busy || [];

    return res.json({ ok: true, busy, is_free: busy.length === 0 });
  } catch (e: any) {
    const msg = String(e?.message || "");
    if (msg === "google_not_connected") return res.status(409).json({ error: "google_not_connected" });
    return res.status(500).json({ error: "internal" });
  }
});

// POST /api/appointments/google/book
router.post("/book", async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req, res);
    if (!tenantId) return res.status(401).json({ error: "unauthorized" });

    const gate = await canUseChannel(tenantId, "google_calendar");
    if (!gate.settings_enabled) return res.status(403).json({ error: "google_calendar_disabled" });

    const { summary, description, startISO, endISO, timeZone, calendarId } = req.body || {};
    if (!summary || !startISO || !endISO || !timeZone) {
      return res.status(400).json({ error: "missing_fields" });
    }

    // (opcional) validación: evitar doble booking haciendo freebusy del slot exacto
    const fb = await googleFreeBusy({
      tenantId,
      timeMin: startISO,
      timeMax: endISO,
      calendarId: calendarId || "primary",
    });
    const busy = fb?.calendars?.[calendarId || "primary"]?.busy || [];
    if (busy.length > 0) return res.status(409).json({ error: "slot_busy", busy });

    const event = await googleCreateEvent({
      tenantId,
      calendarId: calendarId || "primary",
      summary,
      description,
      startISO,
      endISO,
      timeZone,
    });

    // (opcional) persistir en tu DB appointments si ya tienes tabla
    // await pool.query(`INSERT INTO appointments (...) VALUES (...)`, [...]);

    return res.json({ ok: true, event_id: event?.id, htmlLink: event?.htmlLink || null });
  } catch (e: any) {
    const msg = String(e?.message || "");
    if (msg === "google_not_connected") return res.status(409).json({ error: "google_not_connected" });
    return res.status(500).json({ error: "internal" });
  }
});

export default router;
