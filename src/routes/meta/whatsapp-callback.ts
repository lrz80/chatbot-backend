// src/routes/meta/whatsapp-callback.ts
import express, { Request, Response } from "express";

const router = express.Router();

// Debe ser el mismo valor que pusiste en el panel de Meta (Verify Token)
const VERIFY_TOKEN =
  process.env.META_WEBHOOK_VERIFY_TOKEN || "aamy-meta-verify";

/**
 * GET /api/meta/whatsapp/callback
 *
 * Verificación del webhook (hub.challenge)
 */
router.get("/whatsapp/callback", (req: Request, res: Response) => {
  try {
    console.log("🌐 [META WEBHOOK] GET verificación:", req.query);

    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ [META WEBHOOK] Verificación OK");
      return res.status(200).send(challenge as string);
    }

    console.warn("⚠️ [META WEBHOOK] Verificación fallida", {
      mode,
      token,
      expected: VERIFY_TOKEN,
    });
    return res.sendStatus(403);
  } catch (err) {
    console.error("❌ [META WEBHOOK] Error en verificación:", err);
    return res.sendStatus(500);
  }
});

/**
 * Middleware solo para log del hit (no lógica)
 */
router.use((req, _res, next) => {
  console.log("🔔 [WA CALLBACK HIT]", req.method, req.originalUrl);
  next();
});

/**
 * POST /api/meta/whatsapp/callback
 *
 * En modo Twilio:
 * - IGNORA messages (evita doble procesamiento)
 * - SOLO acepta statuses (sent / delivered / read)
 */
router.post("/whatsapp/callback", async (req: Request, res: Response) => {
  try {
    // Validación mínima
    if (req.body?.object !== "whatsapp_business_account") {
      return res.sendStatus(200);
    }

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // 🚫 IGNORAR mensajes entrantes (Twilio es el canal activo)
    if (Array.isArray(value?.messages) && value.messages.length > 0) {
      console.log(
        "🚫 [META WEBHOOK] Messages ignorados (Twilio activo)."
      );
      return res.sendStatus(200);
    }

    // 📦 Aceptar SOLO statuses (sent / delivered / read)
    if (Array.isArray(value?.statuses) && value.statuses.length > 0) {
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ [META WEBHOOK] Error procesando evento:", err);
    return res.sendStatus(200); // Meta SIEMPRE espera 200
  }
});

export default router;
