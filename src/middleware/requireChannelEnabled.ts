import { Request, Response, NextFunction } from "express";
import { getFeatures, isPaused } from "../lib/features";

type Canal = "whatsapp" | "meta" | "voice" | "sms" | "email";

export function requireChannelEnabled(canal: Canal) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // 1) Obtén tenant_id de varias fuentes
      const tenantId =
        (req as any).user?.tenant_id ||
        (req as any).tenant_id ||
        (req as any).tenantId ||
        null;

      // Si no hay tenant aún (p.ej. inbound WhatsApp), permite que tu handler lo resuelva
      // y vuelva a llamar a este middleware luego, o bien intenta mapear aquí.
      if (!tenantId) {
        // Si quieres bloquear sin tenant resuelto:
        return res.status(401).json({ error: "unauthorized" });
      }

      // 2) Lee flags combinando global + tenant
      const feats = await getFeatures(tenantId);

      const enabled = feats[`${canal}_enabled`] === true;
      const pausedUntil = feats[`paused_until_${canal}`] || feats.paused_until; // soporte global
      const allowed = enabled && !isPaused(pausedUntil);

      if (!allowed) {
        // 3) Respuestas por canal
        if (canal === "voice") {
          // Twilio Voice: devuelve TwiML cortito
          res.type("text/xml");
          return res
            .status(503)
            .send(
              `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Lo sentimos. Este canal está en mantenimiento. Inténtalo más tarde.</Say></Response>`
            );
        }
        return res
          .status(503)
          .json({ error: "channel_unavailable", canal, maintenance: true });
      }

      return next();
    } catch (e) {
      console.error("requireChannelEnabled error", e);
      return res.status(500).json({ error: "internal" });
    }
  };
}
