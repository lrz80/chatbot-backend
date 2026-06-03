//src/lib/voice/realtime/socket/sendRealtimeJson.ts
import WebSocket from "ws";

export function sendRealtimeJson(
  socket: WebSocket,
  payload: Record<string, unknown>
): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}