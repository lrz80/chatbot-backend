import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();
console.log("🧪 Firebase PRIVATE_KEY:", process.env.FIREBASE_PRIVATE_KEY ? '✅ CARGADA' : '❌ VACÍA');

import authRoutes from './routes/auth.js';

const app = express();
app.use(cors());
app.use(express.json());

app.use('/auth', authRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
