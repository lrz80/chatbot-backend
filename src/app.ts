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


dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = [
  'http://localhost:3000',
  'https://www.aamy.ai',
];

// ✅ CORS middleware
app.use(cors({
  origin: 'https://www.aamy.ai',
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

// ✅ Servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});

// Ping para mantener activo Railway
setInterval(() => {
  fetch('https://chatbot-backend-production-5c39.up.railway.app/')
    .then(() => console.log('🔁 Ping enviado a backend'))
    .catch(() => console.warn('⚠️ Ping fallido'));
}, 14 * 30); // cada 30 segundos