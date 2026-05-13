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

function normalizeTwilioPhone(value: unknown): string {
  return String(value || "")
    .replace(/^tel:/, "")
    .trim();
}

router.post("/", async (req: Request, res: Response) => {
  const didNumber = normalizeTwilioPhone(req.body.To);
  const callerPhone = normalizeTwilioPhone(req.body.From);

  if (!didNumber || !callerPhone) {
    console.error("[VOICE_REALTIME][INVALID_TWILIO_WEBHOOK_PAYLOAD]", {
      to: req.body.To,
      from: req.body.From,
      callSid: req.body.CallSid,
    });

    const vr = new twiml.VoiceResponse();
    vr.say(
      {
        voice: "Polly.Joanna",
        language: "en-US",
      },
      "Sorry, we could not start this call. Please try again later."
    );

    return res.type("text/xml").send(vr.toString());
  }

  const vr = new twiml.VoiceResponse();
  const wsBaseUrl = getPublicWsBaseUrl();

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

  stream.parameter({
    name: "callerPhone",
    value: callerPhone,
  });

  stream.parameter({
    name: "callSid",
    value: String(req.body.CallSid || "").trim(),
  });

  return res.type("text/xml").send(vr.toString());
});

export default router;