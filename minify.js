import fs from 'fs';

const filePath = './firebase-service-account.json';

try {
  const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const minified = JSON.stringify(json).replace(/\n/g, '\\n');
  console.log("\n🔒 Tu JSON minificado:\n");
  console.log(minified);
} catch (err) {
  console.error('❌ Error al leer o minificar:', err.message);
}
