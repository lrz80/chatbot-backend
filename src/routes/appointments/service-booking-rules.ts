//src/routes/appointments/service-booking-rules.ts
import { Router, Request, Response } from "express";
import { authenticateUser } from "../../middleware/auth";
import {
  getAppointmentServiceRules,
  replaceAppointmentServiceRules,
  type BookingMode,
} from "../../lib/appointments/serviceBookingRules.repo";

const router = Router();

type SanitizedServiceBookingRule = {
  service_name: string;
  duration_min: number;
  booking_mode: BookingMode;
  slot_capacity: number;
};

function getTenantId(req: Request, res: Response) {
  return (
    (req as any).user?.tenant_id ??
    (res.locals as any)?.tenant_id ??
    (req as any).tenant_id ??
    (req as any).tenantId
  );
}

function normalizeBookingMode(value: unknown): BookingMode {
  return value === "shared" ? "shared" : "exclusive";
}

router.get("/", authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req, res);

    if (!tenantId) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const rules = await getAppointmentServiceRules(String(tenantId));

    return res.json({
      ok: true,
      rules,
    });
  } catch (error) {
    console.error("❌ GET /appointments/service-booking-rules:", error);
    return res.status(500).json({
      ok: false,
      error: "internal_error",
    });
  }
});

router.put("/", authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req, res);

    if (!tenantId) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const rawRules = Array.isArray(req.body?.rules) ? req.body.rules : null;

    if (!rawRules) {
      return res.status(400).json({
        ok: false,
        error: "rules_must_be_array",
      });
    }

    const sanitizedRules: SanitizedServiceBookingRule[] = [];

    for (const rawRule of rawRules as unknown[]) {
      const rule = rawRule as {
        service_name?: unknown;
        duration_min?: unknown;
        booking_mode?: unknown;
        slot_capacity?: unknown;
      };

      const sanitizedRule: SanitizedServiceBookingRule = {
        service_name: String(rule.service_name || "").trim(),
        duration_min: Number(rule.duration_min),
        booking_mode: normalizeBookingMode(rule.booking_mode),
        slot_capacity: Number(rule.slot_capacity),
      };

      if (sanitizedRule.service_name.length > 0) {
        sanitizedRules.push(sanitizedRule);
      }
    }

    for (const rule of sanitizedRules) {
      if (!Number.isInteger(rule.duration_min) || rule.duration_min <= 0) {
        return res.status(400).json({
          ok: false,
          error: `invalid_duration_min:${rule.service_name}`,
        });
      }

      if (!Number.isInteger(rule.slot_capacity) || rule.slot_capacity <= 0) {
        return res.status(400).json({
          ok: false,
          error: `invalid_slot_capacity:${rule.service_name}`,
        });
      }

      if (
        rule.booking_mode !== "exclusive" &&
        rule.booking_mode !== "shared"
      ) {
        return res.status(400).json({
          ok: false,
          error: `invalid_booking_mode:${rule.service_name}`,
        });
      }

      if (rule.booking_mode === "exclusive" && rule.slot_capacity !== 1) {
        return res.status(400).json({
          ok: false,
          error: `exclusive_requires_capacity_1:${rule.service_name}`,
        });
      }
    }

    const dedupedMap = new Map<string, (typeof sanitizedRules)[number]>();

    for (const rule of sanitizedRules) {
      dedupedMap.set(rule.service_name.toLowerCase(), rule);
    }

    const savedRules = await replaceAppointmentServiceRules({
      tenantId: String(tenantId),
      rules: Array.from(dedupedMap.values()),
    });

    return res.json({
      ok: true,
      rules: savedRules,
    });
  } catch (error) {
    console.error("❌ PUT /appointments/service-booking-rules:", error);
    return res.status(500).json({
      ok: false,
      error: "internal_error",
    });
  }
});

export default router;