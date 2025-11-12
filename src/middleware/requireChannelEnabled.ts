// src/middleware/requireChannelEnabled.ts
import { Request, Response, NextFunction } from "express";
import { canUseChannel, type Canal } from "../lib/features";
import { getMaintenance } from "../lib/maintenance";

export function requireChannelEnabled(canal: Canal) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId =
        (req as any).user?.tenant_id ??
        (res.locals as any)?.tenant_id ??
        (req as any).tenant_id ??
        (req as any).tenantId;

      if (!tenantId) return res.status(401).json({ error: "unauthorized" });

      const gate = await canUseChannel(tenantId, canal);
      const maint = await getMaintenance(canal as any, tenantId);

      // bloqueos en orden de prioridad
      if (maint?.maintenance) {
        return res.status(503).json({
          error: "maintenance",
          canal,
          message: maint?.message || "Este canal está en mantenimiento temporalmente.",
        });
      }
      if (!gate.plan_enabled) {
        return res.status(403).json({ error: "blocked_by_plan", canal });
      }
      if (gate.reason === "paused") {
        return res.status(403).json({ error: "paused", canal, paused_until: gate.paused_until });
      }
      if (!gate.settings_enabled) {
        return res.status(403).json({ error: "disabled_in_settings", canal });
      }

      return next();
    } catch (e) {
      console.error("requireChannelEnabled error:", e);
      return res.status(500).json({ error: "internal" });
    }
  };
}
