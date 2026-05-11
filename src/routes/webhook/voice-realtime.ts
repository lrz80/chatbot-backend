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

router.post("/", async (req: Request, res: Response) => {
  const vr = new twiml.VoiceResponse();

  const wsBaseUrl = getPublicWsBaseUrl();

  const didNumber = String(req.body.To || "")
    .replace(/^tel:/, "")
    .trim();

  const stream = vr.connect().stream({
    url: `${wsBaseUrl}/realtime/voice-stream`,
  });

  stream.parameter({
    name: "didNumber",
    value: didNumber,
  });

  stream.parameter({
    name: "channelKey",
    value: "voice",
  });

  return res.type("text/xml").send(vr.toString());
});

export default router;