// src/routes/meta/whatsapp-callback.ts
import express, { Request, Response } from "express";

const router = express.Router();

// Debe coincidir con el que pusiste en Railway
const VERIFY_TOKEN = process.env.META_WHATSAPP_VERIFY_TOKEN || "";

router.get("/", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("⬅️ [META WA] GET /api/meta-webhook", req.query);

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Meta WhatsApp webhook verificado correctamente");
    return res.status(200).send(challenge as string);
  }

  console.warn(
    "❌ Meta WhatsApp webhook: verify_token incorrecto o modo inválido",
    { mode, token }
  );
  return res.sendStatus(403);
});

router.post("/", (req: Request, res: Response) => {
  console.log(
    "📦 [META WA] POST /api/meta-webhook RAW BODY:",
    JSON.stringify(req.body, null, 2)
  );

  // Intentamos leer algún "state" si viniera del Embedded Signup
  const body: any = req.body || {};
  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value || {};

  const state =
    value?.meta?.state || // algunas integraciones lo traen aquí
    value?.state || // o plano
    null;

  console.log("🔍 [META WA] STATE recibido en POST:", state);

  // De momento SOLO devolvemos 200, sin tocar la base de datos
  return res.sendStatus(200);
});

export default router;
