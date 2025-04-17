import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/auth';
import settingsRoutes from './routes/settings'; // ✅ Importa el nuevo archivo
import dotenv from 'dotenv';
import tenantRoutes from './routes/tenants';
import promptRoutes from './routes/prompt';
import voiceConfigRoutes from './routes/voiceConfig';
import keywordsRoutes from './routes/keywords';
import usageRoutes from './routes/usage';
import statsRoutes from './routes/stats-kpis';
import statsMonthlyRoutes from './routes/stats-monthly';
import whatsappWebhook from './routes/webhook/whatsapp';
import smsWebhook from './routes/webhook/sms';
import voiceWebhook from './routes/webhook/voice';
import voiceResponse from './routes/webhook/voice-response';


dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = [
  'http://localhost:3000',
  'https://www.aamy.ai',
];

// ✅ CORS middleware
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, origin); // ✅ devolver el origin exacto
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// ✅ Middlewares base
app.use(express.json());
app.use(cookieParser());

// ✅ Rutas
app.use('/auth', authRoutes);
app.use('/api/settings', settingsRoutes); // ✅ Ruta de settings agregada

// ✅ Ping de salud
app.get('/', (req, res) => {
  res.send('Backend corriendo 🟢');
});

console.log('🔄 Reiniciando servidor con nuevas rutas...');

app.use('/api/tenants', tenantRoutes);
app.use('/api/prompt', promptRoutes);
app.use('/api/voice-config', voiceConfigRoutes);
app.use('/api/keywords', keywordsRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/stats/monthly', statsMonthlyRoutes);
app.use('/webhook/whatsapp', whatsappWebhook);
app.use('/webhook/sms', smsWebhook);
app.use('/webhook/voice', voiceWebhook);
app.use('/webhook/voice', voiceWebhook);
app.use('/webhook/voice-response', voiceResponse);

// ✅ Servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});

// Ping para mantener activo Railway
setInterval(() => {
  fetch('https://chatbot-backend-production-8668.up.railway.app/')
    .then(() => console.log('🔁 Ping enviado a backend'))
    .catch(() => console.warn('⚠️ Ping fallido'));
}, 1000 * 30); // cada 30 segundos