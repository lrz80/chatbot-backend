// backend/src/lib/socket.ts
import { Server } from "socket.io";
import type { Server as HttpServer } from "http";

let io: Server | null = null;

/**
 * Inicializa Socket.IO sobre el servidor HTTP de Express
 */
export function initSocket(httpServer: HttpServer, allowedOrigins: string[]) {
  io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  io.on("connection", (socket) => {
    console.log("🔌 [socket] Cliente conectado:", socket.id);

    socket.on("disconnect", () => {
      console.log("🔌 [socket] Cliente desconectado:", socket.id);
    });
  });
}

/**
 * Devuelve la instancia global de io
 */
export function getIO(): Server {
  if (!io) {
    throw new Error("Socket.IO no ha sido inicializado todavía");
  }
  return io;
}
