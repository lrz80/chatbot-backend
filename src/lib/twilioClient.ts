// 📁 src/lib/twilioClient.ts

import twilio from 'twilio';

if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
  console.error('❌ Error: Faltan variables de Twilio (TWILIO_ACCOUNT_SID o TWILIO_AUTH_TOKEN)');
  throw new Error('Twilio no configurado correctamente');
}

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!
);

export default client;
