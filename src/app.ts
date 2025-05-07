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
import faqRouter from './routes/faq';
import intentsRouter from './routes/intents';
import verifyRoutes from './routes/verify';
import forgotPasswordRoute from './routes/auth/forgot-password';
import checkoutRoute from './routes/stripe/checkout';
import stripeWebhook from './routes/stripe/webhook'; // 👈 Este debe ir ANTES del json
import flowsRoutes from "./routes/flows";
import statsKpisRouter from './routes/stats-kpis';
import uploadLogoRoute from './routes/upload-logo';
import campaignsRoutes from "./routes/campaigns";
import uploadContactos from "./routes/contactos/upload";
import deleteContactos from "./routes/contactos/delete";
import countContactos from "./routes/contactos/count";
import voicePromptRoute from "./routes/voice-prompt";
import voiceWebhookRoute from "./routes/webhook/voice";
import testRoute from "./routes/test";
import salesLeadsRouter from './routes/sales-intelligence/leads';
import followUpSettingsRouter from './routes/follow-up-settings';
import { sendScheduledMessages } from './jobs/sendScheduledMessages';
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


dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

console.log('🔐 STRIPE KEY desde ENV:', process.env.STRIPE_SECRET_KEY);

console.log("🔁 Versión redeployada manualmente");


const app = express();
const PORT = process.env.PORT || 3001;

// ✅ Lista blanca de dominios
const allowedOrigins = [
  'http://localhost:3000',
  'https://www.aamy.ai',
];

// ✅ CORS middleware
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, origin);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// ✅ Webhook Stripe primero (usa body raw, no json)
app.use(
  '/api/stripe/webhook',
  bodyParser.raw({ type: 'application/json' }),
  stripeWebhook
);

// ✅ Middlewares globales
app.use(express.json()); // después del webhook para no interferir
app.use(express.urlencoded({ extended: true }));
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
app.use('/webhook/whatsapp', whatsappWebhook);
app.use('/webhook/sms', smsWebhook);
app.use('/webhook/voice-response', voiceResponse);
app.use('/api/messages', messagesRoutes);
app.use('/api/generar-prompt', generarPromptRouter);
app.use('/api/preview', previewRouter);
app.use('/api/faq', faqRouter);
app.use('/api/intents', intentsRouter);
app.use('/api/verify', verifyRoutes);
app.use(forgotPasswordRoute);
app.use('/api/stripe', checkoutRoute); // otras rutas de Stripe (no webhook)
app.use('/api/flows', flowsRoutes);
app.use('/api/stats', statsKpisRouter);
app.use('/api/upload-logo', uploadLogoRoute);
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use("/api/campaigns", campaignsRoutes);
app.use("/api/contactos", uploadContactos);
app.use("/api/contactos", deleteContactos);
app.use("/api/contactos/count", countContactos);
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

setInterval(() => {
  sendScheduledMessages();
}, 60000); // cada 60 segundos

// ✅ Levantar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});

