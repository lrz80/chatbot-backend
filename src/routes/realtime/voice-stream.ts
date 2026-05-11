//src/routes/realtime/voice-stream.ts
import type { Server } from "http";
import WebSocket, { WebSocketServer } from "ws";
import { createOpenAiRealtimeBridge } from "../../lib/voice/realtime/openaiRealtimeBridge";

export function attachVoiceRealtimeStream(server: Server): void {
  const wss = new WebSocketServer({
    server,
    path: "/realtime/voice-stream",
  });

  wss.on("connection", (twilioSocket: WebSocket, req) => {
    console.log("[VOICE_REALTIME][TWILIO_CONNECTED]", {
      url: req.url,
      remoteAddress: req.socket.remoteAddress,
    });

    createOpenAiRealtimeBridge({
      twilioSocket,
    }).catch((error) => {
      console.error("[VOICE_REALTIME][BRIDGE_BOOT_ERROR]", error);

      if (twilioSocket.readyState === WebSocket.OPEN) {
        twilioSocket.close();
      }
    });
  });

  console.log("[VOICE_REALTIME][WS_ATTACHED] /realtime/voice-stream");
}