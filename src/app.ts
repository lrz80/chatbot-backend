import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/auth';
import settingsRoutes from './routes/settings'; // ✅ Importa el nuevo archivo
import dotenv from 'dotenv';
import tenantRoutes from './routes/tenants';
import promptRoutes from './routes/prompt';
import voiceConfigRoutes from './routes/voiceConfig';

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
      callback(null, true);
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

app.use('/api/tenants', tenantRoutes);
app.use('/api/prompt', promptRoutes);
app.use('/api/voice-config', voiceConfigRoutes);

// ✅ Servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
