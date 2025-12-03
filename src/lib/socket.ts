// src/lib/socket.ts
import { Server as HttpServer } from 'http';
import { Server as IOServer, Socket } from 'socket.io';

let io: IOServer | null = null;

/**
 * Inicializa Socket.IO sobre el servidor HTTP de Express.
 * Debes llamar a esta función una sola vez desde tu archivo principal (index.ts / server.ts).
 */
export function initSocket(server: HttpServer) {
  io = new IOServer(server, {
    cors: {
      origin: [
        'https://www.aamy.ai',
        'https://aamy.ai',
        'http://localhost:3000'
      ],
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  io.on('connection', (socket: Socket) => {
    console.log('🟢 Socket conectado:', socket.id);

    // El frontend enviará el tenantId en el handshake (lo veremos en otro paso)
    const tenantId = socket.handshake.auth?.tenantId as string | undefined;

    if (tenantId) {
      socket.join(tenantId);
      console.log(`📡 Socket ${socket.id} unido al tenant ${tenantId}`);
    } else {
      console.warn('⚠️ Socket sin tenantId, desconectando');
      socket.disconnect();
    }

    socket.on('disconnect', () => {
      console.log('🔴 Socket desconectado:', socket.id);
    });
  });

  return io;
}

/**
 * Devuelve la instancia de io ya inicializada.
 * Lanza error si alguien la usa antes de initSocket.
 */
export function getIO(): IOServer {
  if (!io) {
    throw new Error('Socket.io no inicializado. Llama a initSocket(server) primero.');
  }
  return io;
}
