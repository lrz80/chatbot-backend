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
import voiceWebhook from './routes/webhook/voice';
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
import promptVoiceRoute from "./routes/prompt-generator/voice";

dotenv.config();

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
app.use('/webhook/voice', voiceWebhook);
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
app.use('/uploads', express.static('uploads'));
app.use("/api/campaigns", campaignsRoutes);
app.use("/api/contactos", uploadContactos);
app.use("/api/contactos", deleteContactos);
app.use("/api/contactos/count", countContactos);
app.use("/api/prompt-generator/voice", promptVoiceRoute);

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

