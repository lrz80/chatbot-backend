// src/routes/meta/index.ts
import { Router } from "express";

import whatsappCallback from "./whatsapp-callback";
import whatsappRedirect from "./whatsapp-redirect";
import whatsappPhoneNumbers from "./whatsapp-phone-numbers";
import whatsappOnboardStart from "./whatsapp-onboard-start";
import whatsappAccounts from "./whatsapp-accounts";
import whatsappRegister from "./whatsapp-register";
import whatsappSaveToken from "./whatsapp-save-token";
import whatsappResolveWaba from "./whatsapp-resolve-waba";
import whatsappExchangeCode from "./whatsapp-exchange-code";
import whatsappCloudApi from "./whatsapp-cloudapi";

// si vas a separar onboard-complete/debug/test-send/connection:
import whatsappOnboardComplete from "./whatsapp-onboard-complete";
import whatsappDebug from "./whatsapp-debug";
import whatsappConnection from "./whatsapp-connection";

const router = Router();

// Monta routers (SIN rutas inline aquí)
router.use("/", whatsappCallback);
router.use("/", whatsappRedirect);
router.use("/", whatsappPhoneNumbers);
router.use("/", whatsappOnboardStart);
router.use("/", whatsappAccounts);
router.use("/", whatsappRegister);
router.use("/", whatsappSaveToken);
router.use("/", whatsappResolveWaba);
router.use("/", whatsappExchangeCode);
router.use("/", whatsappCloudApi);

// opcionales si los separas
router.use("/", whatsappOnboardComplete);
router.use("/", whatsappDebug);
router.use("/", whatsappConnection);

export default router;
