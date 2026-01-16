// src/routes/test.ts
import { Router, Request, Response } from "express";
import { authenticateUser } from "../middleware/auth";
import { googleFreeBusy, googleCreateEvent } from "../services/googleCalendar";

const router = Router();
router.use(authenticateUser);

/**
 * GET /api/test/google-availability
 * Prueba rápida desde el navegador
 */
router.get("/google-availability", async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    if (!tenantId) return res.status(401).json({ error: "unauthorized" });

    const timeMin = "2026-01-17T14:00:00-05:00";
    const timeMax = "2026-01-17T14:30:00-05:00";

    const fb = await googleFreeBusy({
      tenantId,
      timeMin,
      timeMax,
      calendarId: "primary",
    });

    const busy = fb?.calendars?.primary?.busy || [];

    return res.json({
      ok: true,
      timeMin,
      timeMax,
      busy,
      is_free: busy.length === 0,
    });
  } catch (e: any) {
    console.error("❌ test google-availability error:", e);
    return res.status(500).json({
      error: e?.message || "internal",
    });
  }
});

/**
 * GET /api/test/google-book
 * Crea una cita de prueba
 */
router.get("/google-book", async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    if (!tenantId) return res.status(401).json({ error: "unauthorized" });

    const event = await googleCreateEvent({
      tenantId,
      calendarId: "primary",
      summary: "Cita de prueba Aamy",
      description: "Creada desde /api/test/google-book",
      startISO: "2026-01-17T14:00:00-05:00",
      endISO: "2026-01-17T14:30:00-05:00",
      timeZone: "America/New_York",
    });

    return res.json({
      ok: true,
      event_id: event?.id,
      htmlLink: event?.htmlLink || null,
    });
  } catch (e: any) {
    console.error("❌ test google-book error:", e);
    return res.status(500).json({
      error: e?.message || "internal",
    });
  }
});

router.get("/book-db-and-google", async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    if (!tenantId) return res.status(401).json({ error: "unauthorized" });

    const resp = await fetch("https://api.aamy.ai/api/appointments/book", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: req.headers.cookie || "" } as any,
      body: JSON.stringify({
        customer_name: "Cliente Test",
        customer_phone: "+10000000000",
        start_time: "2026-01-17T15:00:00-05:00",
        end_time: "2026-01-17T15:30:00-05:00",
        timeZone: "America/New_York",
        notes: "Reservada por prueba",
        channel: "dashboard",
        service_id: null,
      }),
    });

    const json = await resp.json();
    return res.status(resp.status).json(json);
  } catch (e: any) {
    console.error("test book-db-and-google error:", e);
    return res.status(500).json({ error: e?.message || "internal" });
  }
});

export default router;
