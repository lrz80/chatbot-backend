// src/routes/meta/index.ts
import { Router } from "express";
import whatsappOnboard from "./whatsapp-onboard";
import whatsappCallback from "./whatsapp-callback";
import whatsappRedirect from "./whatsapp-redirect";

const router = Router();

// Ruta que recibe los datos del Embedded Signup
router.use("/whatsapp/onboard-complete", whatsappOnboard);

// Ruta que recibe el callback de Meta después del signup
router.use("/whatsapp/callback", whatsappCallback);

// Ruta opcional que usa tu front al regresar desde Meta
router.use("/whatsapp-redirect", whatsappRedirect);

export default router;
