import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initFirebase } from './firebase/admin.js'; // 👈 importar Firebase

dotenv.config();
initFirebase();

console.log("🧪 Firebase PRIVATE_KEY:", process.env.FIREBASE_PRIVATE_KEY ? '✅ CARGADA' : '❌ VACÍA');

import authRoutes from './routes/auth.js';

const app = express();
app.use(cors());
app.use(express.json());

app.use('/auth', authRoutes);

const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
  res.send('✅ Backend activo');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
