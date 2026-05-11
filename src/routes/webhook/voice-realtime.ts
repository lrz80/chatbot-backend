//src/routes/webhook/voice-realtime.ts
import { Router, Request, Response } from "express";
import { twiml } from "twilio";

const router = Router();

function getPublicWsBaseUrl(): string {
  const configured = process.env.PUBLIC_WS_URL?.trim();

  if (configured) {
    return configured.replace(/\/$/, "");
  }

  return "wss://api.aamy.ai";
}

router.post("/", async (_req: Request, res: Response) => {
  const vr = new twiml.VoiceResponse();

  const wsBaseUrl = getPublicWsBaseUrl();

  vr.connect().stream({
    url: `${wsBaseUrl}/realtime/voice-stream`,
  });

  return res.type("text/xml").send(vr.toString());
});

export default router;