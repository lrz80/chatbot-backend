// src/lib/socket.ts

import { Server } from "socket.io";
import type { Server as HttpServer } from "http";

let io: Server | null = null;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function getTenantSocketRoom(tenantId: string): string {
  const normalizedTenantId = clean(tenantId);

  if (!normalizedTenantId) {
    throw new Error("SOCKET_TENANT_ID_REQUIRED");
  }

  return `tenant:${normalizedTenantId}`;
}

/**
 * Inicializa Socket.IO sobre el servidor HTTP de Express.
 */
export function initSocket(
  httpServer: HttpServer,
  allowedOrigins: string[]
) {
  io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  io.on("connection", (socket) => {
    console.log(
      "🔌 [socket] Cliente conectado:",
      socket.id
    );

    /**
     * Suscribe el socket a un tenant.
     *
     * IMPORTANTE:
     * Esto crea aislamiento de transporte por rooms.
     * El tenantId debe ser el tenant actualmente autenticado
     * que el frontend obtiene desde /api/settings.
     */
    socket.on(
      "tenant:subscribe",
      (payload: { tenantId?: string } | undefined) => {
        try {
          const tenantId = clean(payload?.tenantId);

          if (!tenantId) {
            console.warn(
              "[SOCKET][TENANT_SUBSCRIBE_REJECTED]",
              {
                socketId: socket.id,
                reason: "TENANT_ID_REQUIRED",
              }
            );

            return;
          }

          // El socket solo debe permanecer en un room tenant:*.
          for (const room of socket.rooms) {
            if (
              room.startsWith("tenant:") &&
              room !== getTenantSocketRoom(tenantId)
            ) {
              void socket.leave(room);
            }
          }

          const tenantRoom =
            getTenantSocketRoom(tenantId);

          void socket.join(tenantRoom);

          console.log(
            "[SOCKET][TENANT_SUBSCRIBED]",
            {
              socketId: socket.id,
              tenantId,
              room: tenantRoom,
            }
          );
        } catch (error) {
          console.error(
            "[SOCKET][TENANT_SUBSCRIBE_FAILED]",
            {
              socketId: socket.id,
              error:
                error instanceof Error
                  ? error.message
                  : String(error),
            }
          );
        }
      }
    );

    socket.on("disconnect", () => {
      console.log(
        "🔌 [socket] Cliente desconectado:",
        socket.id
      );
    });
  });
}

/**
 * Devuelve la instancia global de Socket.IO.
 */
export function getIO(): Server {
  if (!io) {
    throw new Error(
      "Socket.IO no ha sido inicializado todavía"
    );
  }

  return io;
}

/**
 * Emite un evento exclusivamente a los sockets
 * suscritos al tenant indicado.
 */
export function emitToTenant(
  tenantId: string,
  eventName: string,
  payload: unknown
): void {
  const tenantRoom =
    getTenantSocketRoom(tenantId);

  getIO()
    .to(tenantRoom)
    .emit(eventName, payload);
}