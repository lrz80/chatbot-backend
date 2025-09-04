// chatbot-backend/src/app.ts

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';

// Rutas principales
import authRoutes from './routes/auth';
import settingsRoutes from './routes/settings';
import tenantRoutes from './routes/tenants';
import promptRoutes from './routes/prompt';
import voiceConfigRoutes from "./routes/voice-config";
import keywordsRoutes from './routes/keywords';
import usageRoutes from './routes/usage';
import statsMonthlyRoutes from './routes/stats-monthly';
import whatsappWebhook from './routes/webhook/whatsapp';
import smsWebhook from './routes/webhook/sms';
import voiceResponse from './routes/webhook/voice-response';
import messagesRoutes from './routes/messages';
import generarPromptRouter from './routes/generar-prompt';
import previewRouter from './routes/preview';
import faqsRoutes from './routes/faqs';
import intentsRouter from './routes/intents';
import verifyRoutes from './routes/verify';
import forgotPasswordRoute from './routes/auth/forgot-password';
import checkoutRoute from './routes/stripe/checkout';
import stripeWebhook from './routes/stripe/webhook'; // 👈 Este debe ir ANTES del json
import flowsRoutes from "./routes/flows";
import statsKpisRouter from './routes/stats-kpis';
import uploadLogoRoute from './routes/upload-logo';
import campaignsRoutes from "./routes/campaigns";
import voicePromptRoute from "./routes/voice-prompt";
import voiceWebhookRoute from "./routes/webhook/voice";
import testRoute from "./routes/test";
import salesLeadsRouter from './routes/sales-intelligence/leads';
import followUpSettingsRouter from './routes/follow-up-settings';
import sendScheduledNowRouter from './routes/jobs/send-scheduled-now';
import sentMessagesRoute from './routes/follow-up/sentMessages';
import facebookOauthCallback from './routes/facebook/oauth-callback';
import facebookWebhook from './routes/facebook/webhook';
import * as path from 'path';
import deleteAccountRoute from './routes/auth/delete';
import elevenlabsVoicesRoute from './routes/elevenlabs/voices';
import voiceLinksRouter from "./routes/voice-links";
import interaccionesPorDia from './routes/stats/interacciones-por-dia';
import usuariosPorDia from './routes/stats/usuarios-por-dia';
import intencionesPorDia from './routes/stats/intenciones-por-dia';
import horaPico from './routes/stats/hora-pico';
import ventasStats from './routes/sales-intelligence/stats';
import mensajesNuevosRouter from "./routes/messages/nuevos";
import contactosRoutes from "./routes/contactos/index";
import smsStatusWebhook from "./routes/webhook/sms-status"; 
import checkoutCreditRoute from './routes/stripe/checkout-credit';
import limiteContactosRoute from './routes/contactos/limite';
import sendgridTemplates from "./routes/sendgrid/templates";
import emailStatusRoute from "./routes/email-status/index";
import previewEmailRouter from "./routes/preview-email";
import stripeCancelRouter from './routes/stripe/cancel';
import resetNotificaciones from './routes/creditos/reset-notificaciones';
import renewMembership from './routes/tenants/renew-membership';
import metaConfigRoutes from './routes/meta-config';
import mensajeConteoRouter from './routes/messages/conteo'; // ✅ nuevo
import faqsSugeridas from './routes/faqs/sugeridas';
import faqsAprobar from './routes/faqs/aprobar';
import faqsRechazar from './routes/faqs/rechazar';
import eliminarFaqRoute from './routes/faqs/eliminar';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: path.resolve(__dirname, '../.env.local') });
}
console.log("🔐 DATABASE_URL en arranque: cargada correctamente");

console.log("🔐 STRIPE KEY desde ENV: cargada correctamente");

console.log("🔁 Versión redeployada manualmente");


const app = express();
const PORT = process.env.PORT || 3001;

app.use("/uploads", express.static(path.join(__dirname, "../public/uploads")));
console.log("📂 Servidor estático montado en:", path.join(__dirname, "../public/uploads"));

const allowedOrigins = ['https://www.aamy.ai', 'https://aamy.ai']; // añade apex si lo usas

app.use(cors({
  origin: (origin, cb) => (!origin || allowedOrigins.includes(origin)) ? cb(null, true) : cb(new Error('Not allowed by CORS')),
  credentials: true,
  methods: ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With','Accept','Origin'],
  optionsSuccessStatus: 204,
}));

app.options('*', cors({
  origin: (origin, cb) => (!origin || allowedOrigins.includes(origin)) ? cb(null, true) : cb(new Error('Not allowed by CORS')),
  credentials: true,
  methods: ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With','Accept','Origin'],
}));


// ✅ Webhook Stripe primero (usa body raw, no json)
app.use(
  '/api/stripe/webhook',
  bodyParser.raw({ type: 'application/json' }),
  stripeWebhook
);

// ✅ Middlewares globales
app.use(express.json());                      // ✅ JSON normal
app.use(express.urlencoded({ extended: false })); // ✅ Twilio (x-www-form-urlencoded)
app.use(cookieParser());

// ✅ Rutas
app.use('/auth', authRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/prompt', promptRoutes);
app.use("/api/voice-config", voiceConfigRoutes);
app.use('/api/keywords', keywordsRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/stats/monthly', statsMonthlyRoutes);
app.use('/webhook/sms', smsWebhook);
app.use('/webhook/voice-response', voiceResponse);
app.use('/api/messages', messagesRoutes);
app.use('/api/generar-prompt', generarPromptRouter);
app.use('/api/preview', previewRouter);
app.use('/api/faqs', faqsRoutes);
app.use('/api/intents', intentsRouter);
app.use('/api/verify', verifyRoutes);
app.use(forgotPasswordRoute);
app.use('/api/stripe', checkoutRoute); // otras rutas de Stripe (no webhook)
app.use('/api/flows', flowsRoutes);
app.use('/api/stats', statsKpisRouter);
app.use('/api/upload-logo', uploadLogoRoute);
app.use("/api/campaigns", campaignsRoutes);
app.use("/api/voice-prompt", voicePromptRoute);
app.use("/api/webhooks/voice", voiceWebhookRoute);
app.use("/api/test", testRoute);
app.use('/api/sales-intelligence/leads', salesLeadsRouter);
app.use('/api/follow-up-settings', followUpSettingsRouter);
app.use('/api/jobs/send-scheduled-now', sendScheduledNowRouter);
app.use('/api/follow-up/sent-messages', sentMessagesRoute);
app.use(facebookOauthCallback);
app.use(facebookWebhook);
app.use('/api/delete-account', deleteAccountRoute);
app.use('/api/elevenlabs/voices', elevenlabsVoicesRoute);
app.use("/api/voice-links", voiceLinksRouter);
app.use('/api/stats/interacciones-por-dia', interaccionesPorDia);
app.use('/api/stats/usuarios-por-dia', usuariosPorDia);
app.use('/api/stats/intenciones-por-dia', intencionesPorDia);
app.use('/api/stats/hora-pico', horaPico);
app.use('/api/sales-intelligence/stats', ventasStats);
app.use("/api/messages/nuevos", mensajesNuevosRouter);
app.use("/api/contactos", contactosRoutes);
app.use("/api/webhook/sms-status", smsStatusWebhook);
app.use('/api/stripe', checkoutCreditRoute);
app.use('/api/contactos/limite', limiteContactosRoute);
app.use("/api/sendgrid/templates", sendgridTemplates);
app.use("/api/email-status", emailStatusRoute);
app.use("/api/preview-email", previewEmailRouter);
app.use("/api/webhook/whatsapp", whatsappWebhook);
app.use('/api/stripe/cancel', stripeCancelRouter);
app.use('/api/creditos', resetNotificaciones);
app.use('/api/tenants', renewMembership);
app.use('/api/meta-config', metaConfigRoutes);
app.use('/api/messages/conteo', mensajeConteoRouter); // ✅ activamos ruta
app.use('/api/faqs/sugeridas', faqsSugeridas);
app.use('/api/faqs/aprobar', faqsAprobar);
app.use('/api/faqs/rechazar', faqsRechazar);
app.use("/api/faqs/eliminar", eliminarFaqRoute);

// ✅ Ruta base
app.get('/', (req, res) => {
  res.send('Backend corriendo 🟢');
});

// ✅ Ping para mantener Railway activo
setInterval(() => {
  fetch('https://api.aamy.ai/')
    .then(() => console.log('🔁 Ping enviado a backend'))
    .catch(() => console.warn('⚠️ Ping fallido'));
}, 1000 * 30);

// ✅ Levantar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
