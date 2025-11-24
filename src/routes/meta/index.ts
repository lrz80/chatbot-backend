// src/routes/meta/index.ts
import { Router } from "express";
import whatsappOnboardStart from "./whatsapp-onboard-start";  // Inicia flujo (genera URL)
import whatsappCallback from "./whatsapp-callback";           // Recibe callback desde Meta
import whatsappRedirect from "./whatsapp-redirect";           // (Opcional) redirección front

const router = Router();

/**
 * 🚀 Iniciar el flujo de conexión con WhatsApp Cloud (genera URL de Meta)
 * Endpoint utilizado por el frontend (ConnectWhatsAppButton)
 * POST https://api.aamy.ai/api/meta/whatsapp-onboard/start
 */
router.use("/whatsapp-onboard/start", whatsappOnboardStart);

/**
 * 📥 Endpoint que recibe el callback real desde Meta con code/token y tenantId
 * GET/POST https://api.aamy.ai/api/meta/whatsapp/callback
 */
router.use("/whatsapp/callback", whatsappCallback);

/**
 * 🌐 (Opcional) Si usas una pantalla intermedia en frontend
 * https://api.aamy.ai/api/meta/whatsapp-redirect
 */
router.use("/whatsapp-redirect", whatsappRedirect);

export default router;
