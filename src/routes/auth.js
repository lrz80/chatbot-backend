import express from 'express';
import { getAuth } from 'firebase-admin/auth';
import { initFirebase } from '../firebase/admin.js';

initFirebase();
const router = express.Router();

router.post('/login', async (req, res) => {
  return res.status(501).send("Handled on frontend using Firebase SDK.");
});

router.post('/register', async (req, res) => {
  return res.status(501).send("Handled on frontend using Firebase SDK.");
});

router.post('/validate', async (req, res) => {
  const { token } = req.body;
  try {
    const decodedToken = await getAuth().verifyIdToken(token);
    res.status(200).json({ uid: decodedToken.uid });
  } catch (error) {
    res.status(401).json({ error: "Invalid token" });
  }
});

export default router;
