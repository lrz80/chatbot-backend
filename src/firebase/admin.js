import { initializeApp, cert, getApps } from 'firebase-admin/app';

export const initFirebase = () => {
  if (getApps().length === 0) {
    const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
    
    initializeApp({
      credential: cert(firebaseConfig)
    });

    console.log('✅ Firebase inicializado con FIREBASE_CONFIG');
  }
};
