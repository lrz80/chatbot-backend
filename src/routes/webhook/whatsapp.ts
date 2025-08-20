// backend/src/routes/webhook/whatsapp.ts

import { Router, Request, Response } from 'express';
import pool from '../../lib/db';
import OpenAI from 'openai';
import twilio from 'twilio';
import { buildDudaSlug, isDirectIntent, normalizeIntentAlias } from '../../lib/intentSlug';
import { getPromptPorCanal, getBienvenidaPorCanal } from '../../lib/getPromptPorCanal';
import { detectarIdioma } from '../../lib/detectarIdioma';
import { traducirMensaje } from '../../lib/traducirMensaje';
import { buscarRespuestaSimilitudFaqsTraducido, buscarRespuestaDesdeFlowsTraducido } from '../../lib/respuestasTraducidas';
import { enviarWhatsApp } from '../../lib/senders/whatsapp';
import {
  yaExisteComoFaqSugerida,
  yaExisteComoFaqAprobada,
  normalizarTexto
} from '../../lib/faq/similaridadFaq';
import { detectarIntencion } from '../../lib/detectarIntencion';
import { runBeginnerRecoInterceptor } from '../../lib/recoPrincipiantes/interceptor';
import { fetchFaqPrecio } from '../../lib/faq/fetchFaqPrecio';

const router = Router();
const MessagingResponse = twilio.twiml.MessagingResponse;

const INTENTS_DIRECT = new Set([
  'interes_clases','precio','horario','ubicacion','reservar','comprar','confirmar',
  'clases_online' // 👈 añade esto
]);

// Intenciones que deben ser únicas por tenant/canal
const INTENT_UNIQUE = new Set([
  'precio','horario','ubicacion','reservar','comprar','confirmar','interes_clases','clases_online'
]);

const enviarWhatsAppSeguro = async (to: string, text: string, tenantId: string) => {
  const MAX = 1500; // margen
  for (let i = 0; i < text.length; i += MAX) {
    await enviarWhatsApp(to, text.slice(i, i + MAX), tenantId);
  }
};

// Normalizadores
const normLang = (code?: string | null) => {
  if (!code) return null;
  const base = code.toString().split(/[-_]/)[0].toLowerCase();
  return base === 'zxx' ? null : base; // zxx = sin lenguaje
};
const normalizeLang = (code?: string | null): 'es' | 'en' =>
  (code || '').toLowerCase().startsWith('en') ? 'en' : 'es';


function getConfigDelayMinutes(cfg: any, fallbackMin = 60) {
  const m = Number(cfg?.minutos_espera);
  if (Number.isFinite(m) && m > 0) return m;
  return fallbackMin;
}

// Acceso a DB para idioma del contacto
async function getIdiomaClienteDB(tenantId: string, contacto: string, fallback: 'es'|'en'): Promise<'es'|'en'> {
  try {
    const { rows } = await pool.query(
      `SELECT idioma FROM clientes WHERE tenant_id = $1 AND contacto = $2 LIMIT 1`,
      [tenantId, contacto]
    );
    if (rows[0]?.idioma) return normalizeLang(rows[0].idioma);
  } catch {}
  return fallback;
}

async function upsertIdiomaClienteDB(tenantId: string, contacto: string, idioma: 'es'|'en') {
  try {
    await pool.query(
      `INSERT INTO clientes (tenant_id, contacto, idioma)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, contacto)
       DO UPDATE SET idioma = EXCLUDED.idioma`,
      [tenantId, contacto, idioma]
    );
  } catch (e) {
    console.warn('No se pudo guardar idioma del cliente:', e);
  }
}

router.post('/', async (req: Request, res: Response) => {
  console.log("📩 Webhook recibido:", req.body);

  const twiml = new MessagingResponse();
  res.type('text/xml').send(new MessagingResponse().toString());

  setTimeout(async () => {
    try {
      await procesarMensajeWhatsApp(req.body);
    } catch (error) {
      console.error("❌ Error procesando mensaje:", error);
    }
  }, 0);
});

export default router;

async function procesarMensajeWhatsApp(body: any) {
  const to = body.To || '';
  const from = body.From || '';
  const numero = to.replace('whatsapp:', '').replace('tel:', '');
  const fromNumber = from.replace('whatsapp:', '').replace('tel:', '');
  const userInput = body.Body || '';
  const messageId = body.MessageSid || body.SmsMessageSid || null;

  const tenantRes = await pool.query('SELECT * FROM tenants WHERE twilio_number = $1 LIMIT 1', [numero]);
  const tenant = tenantRes.rows[0];
  if (!tenant) return;

  // 🚫 No responder si la membresía está inactiva
  if (!tenant.membresia_activa) {
    console.log(`⛔ Membresía inactiva para tenant ${tenant.name || tenant.id}. No se responderá.`);
    return;
  }

  const idioma = await detectarIdioma(userInput);
  const promptBase = getPromptPorCanal('whatsapp', tenant, idioma);
  let respuesta: any = getBienvenidaPorCanal('whatsapp', tenant, idioma);
  const canal = 'whatsapp';

  // 🧹 Cancela cualquier follow-up pendiente para este contacto al recibir nuevo mensaje
  try {
      await pool.query(
        `DELETE FROM mensajes_programados
          WHERE tenant_id = $1 AND canal = $2 AND contacto = $3 AND enviado = false`,
        [tenant.id, canal, fromNumber]
      );
    } catch (e) {
      console.warn('No se pudieron limpiar follow-ups pendientes:', e);
    }

  let flows: any[] = [];
  try {
    const flowsRes = await pool.query('SELECT data FROM flows WHERE tenant_id = $1', [tenant.id]);
    const raw = flowsRes.rows[0]?.data;
    flows = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];

  } catch {}

  let faqs: any[] = [];
  try {
    const faqsRes = await pool.query(
      'SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1 AND canal = $2',
      [tenant.id, canal]
    );    
    faqs = faqsRes.rows || [];
  } catch (err) {
    console.error("❌ Error cargando FAQs:", err);
    faqs = [];
  }  

  const mensajeUsuario = normalizarTexto(userInput);

  // 1️⃣ Detectar si es solo número
  const isNumericOnly = /^\s*\d+\s*$/.test(userInput);

  // 2️⃣ Calcular idiomaDestino
  const tenantBase: 'es'|'en' = normalizeLang(tenant?.idioma || 'es');
  let idiomaDestino: 'es'|'en';

  if (isNumericOnly) {
    idiomaDestino = await getIdiomaClienteDB(tenant.id, fromNumber, tenantBase);
    console.log(`🌍 idiomaDestino= ${idiomaDestino} fuente= DB (solo número)`);
  } else {
    let detectado: string | null = null;
    try { detectado = normLang(await detectarIdioma(userInput)); } catch {}
    const normalizado: 'es'|'en' = normalizeLang(detectado || tenantBase);
    await upsertIdiomaClienteDB(tenant.id, fromNumber, normalizado);
    idiomaDestino = normalizado;
    console.log(`🌍 idiomaDestino= ${idiomaDestino} fuente= userInput`);
  }

  // 3️⃣ Detectar intención
  const { intencion: intencionDetectada } = await detectarIntencion(mensajeUsuario, tenant.id, 'whatsapp');
  const intencionLower = intencionDetectada?.trim().toLowerCase() || "";
  console.log(`🧠 Intención detectada al inicio para tenant ${tenant.id}: "${intencionLower}"`);

  let intencionProc = intencionLower; // se actualizará tras traducir (si aplica)
  let intencionParaFaq = intencionLower; // esta será la que usemos para consultar FAQ

  // 4️⃣ Si es saludo/agradecimiento, solo sal si el mensaje es SOLO eso
  const greetingOnly = /^\s*(hola|buenas(?:\s+(tardes|noches|dias))?|hello|hi|hey)\s*$/i.test(userInput.trim());
  const thanksOnly   = /^\s*(gracias|thank\s*you|ty)\s*$/i.test(userInput.trim());

  if ((intencionLower === "saludo" && greetingOnly) || (intencionLower === "agradecimiento" && thanksOnly)) {
    const respuestaRapida =
      intencionLower === "agradecimiento"
        ? "¡De nada! 💬 ¿Quieres ver otra opción del menú?"
        : await getBienvenidaPorCanal("whatsapp", tenant, idiomaDestino);

    await enviarWhatsAppSeguro(fromNumber, respuestaRapida, tenant.id);
    return;
  }

  if (["hola", "buenas", "hello", "hi", "hey"].includes(mensajeUsuario)) {
    respuesta = getBienvenidaPorCanal('whatsapp', tenant, idiomaDestino); // antes: idioma
  }else {
    // 🛑 Atajo: si el usuario mandó SOLO un número, resolver flujos YA y salir
    if (isNumericOnly && Array.isArray(flows[0]?.opciones) && flows[0].opciones.length) {
      const rawBodyNum = (body.Body ?? '').toString();
      const digitOnlyNum = rawBodyNum.replace(/[^\p{N}]/gu, '').trim();
      const n = Number(digitOnlyNum);
      const opcionesNivel1 = flows[0].opciones;
  
      if (Number.isInteger(n) && n >= 1 && n <= opcionesNivel1.length) {
        const opcionSeleccionada = opcionesNivel1[n - 1];
  
        // 1) Respuesta directa
        if (opcionSeleccionada?.respuesta) {
          let out = opcionSeleccionada.respuesta;
          try {
            const idiomaOut = await detectarIdioma(out);
            if (idiomaOut && idiomaOut !== 'zxx' && idiomaOut !== idiomaDestino) {
              out = await traducirMensaje(out, idiomaDestino);
            }
          } catch {}
          // 📌 Agregar recordatorio al final
          out += "\n\n💡 ¿Quieres ver otra opción del menú? Responde con el número correspondiente.";
          await enviarWhatsAppSeguro(fromNumber, out, tenant.id);
          await pool.query(
            `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
            VALUES ($1, 'assistant', $2, NOW(), $3, $4)`,
            [tenant.id, out, canal, fromNumber || 'anónimo']
          );
          console.log("📬 Respuesta enviada desde opción seleccionada del menú (atajo numérico)");
          return;
        }
  
        // 1.5) Submenú terminal (solo mensaje)
        if (opcionSeleccionada?.submenu && !opcionSeleccionada?.submenu?.opciones?.length) {
          let out = opcionSeleccionada.submenu.mensaje || '';
          if (out) {
            try {
              const langOut = await detectarIdioma(out);
              if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
                out = await traducirMensaje(out, idiomaDestino);
              }
            } catch {}
            await enviarWhatsAppSeguro(fromNumber, out, tenant.id);
            await pool.query(
              `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
               VALUES ($1, 'assistant', $2, NOW(), $3, $4)`,
               [tenant.id, out, canal, fromNumber || 'anónimo']
            );
            console.log("📬 Mensaje enviado desde submenú terminal (atajo numérico).");
            return;
          }
        }
  
        // 2) Submenú con opciones
        if (opcionSeleccionada?.submenu?.opciones?.length) {
          const titulo = opcionSeleccionada.submenu.mensaje || 'Elige una opción:';
          const opcionesSm = opcionSeleccionada.submenu.opciones
            .map((op: any, i: number) => `${i + 1}️⃣ ${op.texto || `Opción ${i + 1}`}`)
            .join('\n');
  
          let menuSm = `💡 ${titulo}\n${opcionesSm}\n\nResponde con el número de la opción que deseas.`;
          try {
            const idMenu = await detectarIdioma(menuSm);
            if (idMenu && idMenu !== 'zxx' && idMenu !== idiomaDestino) {
              menuSm = await traducirMensaje(menuSm, idiomaDestino);
            }
          } catch {}
          await enviarWhatsAppSeguro(fromNumber, menuSm, tenant.id);
          console.log("📬 Submenú enviado (atajo numérico).");
          return;
        }
  
        // Opción válida pero sin contenido → reenvía menú
        const pregunta = flows[0].pregunta || flows[0].mensaje || '¿Cómo puedo ayudarte?';
        const opciones = flows[0].opciones.map((op: any, i: number) => `${i + 1}️⃣ ${op.texto || `Opción ${i + 1}`}`).join('\n');
        let menu = `⚠️ Esa opción aún no tiene contenido. Elige otra.\n\n💡 ${pregunta}\n${opciones}\n\nResponde con el número de la opción que deseas.`;
        try { if (idiomaDestino !== 'es') menu = await traducirMensaje(menu, idiomaDestino); } catch {}
        await enviarWhatsAppSeguro(fromNumber, menu, tenant.id);
        return;
      } else {
        // Número fuera de rango → menú
        const pregunta = flows[0].pregunta || flows[0].mensaje || '¿Cómo puedo ayudarte?';
        const opciones = flows[0].opciones.map((op: any, i: number) => `${i + 1}️⃣ ${op.texto || `Opción ${i + 1}`}`).join('\n');
        let menu = `⚠️ Opción no válida. Intenta de nuevo.\n\n💡 ${pregunta}\n${opciones}\n\nResponde con el número de la opción que deseas.`;
        try { if (idiomaDestino !== 'es') menu = await traducirMensaje(menu, idiomaDestino); } catch {}
        await enviarWhatsAppSeguro(fromNumber, menu, tenant.id);
        return;
      }
    }
  
    // Paso 1: Detectar idioma y traducir para evaluar intención
    const textoTraducido = idiomaDestino !== 'es'
      ? await traducirMensaje(userInput, 'es')
      : userInput;

    const { intencion: intencionProcesada } = await detectarIntencion(textoTraducido, tenant.id, 'whatsapp');
    intencionProc = (intencionProcesada || '').trim().toLowerCase();
    intencionParaFaq = intencionProc; // <- la que usaremos luego en el SELECT de FAQs
    console.log(`🧠 Intención detectada (procesada): "${intencionProc}"`);

    // [ADD] Si la intención es "duda", refinamos a un sub-slug tipo "duda__duracion_clase"
    if (intencionProc === 'duda') {
      const refined = buildDudaSlug(userInput);
      console.log(`🎯 Refino duda → ${refined}`);
      intencionProc = refined;
      intencionParaFaq = refined; // este es el que usas para consultar FAQ
    }

    // 🔹 Canonicaliza alias (virtuales → online, etc.)
    intencionProc = normalizeIntentAlias(intencionProc);
    intencionParaFaq = normalizeIntentAlias(intencionParaFaq);

    // 🔎 Overrides por palabras clave
    const priceRegex = /\b(precio|precios|costo|costos|cuesta|cuestan|tarifa|tarifas|cuota|mensualidad|membres[ií]a|membership|price|prices|cost|fee|fees)\b/i;
    if (priceRegex.test(userInput)) {
      intencionProc = 'precio';
      intencionParaFaq = 'precio';
      console.log('🎯 Override a intención precio por keyword');
    } else if (/\b(?:online|en\s*linea|virtual(?:es|idad)?)\b/i.test(userInput)) {
      intencionProc = 'clases_online';
      intencionParaFaq = 'clases_online';
      console.log('🎯 Override a intención clases_online por keyword');
    }

    const INTENCION_FINAL_CANONICA = (intencionParaFaq || intencionProc || '').trim().toLowerCase();
    console.log(`🎯 Intención final (canónica) = ${INTENCION_FINAL_CANONICA}`);

    if (!isNumericOnly && intencionProc === 'pedir_info' && flows.length > 0 && flows[0].opciones?.length > 0) {
    
    const pregunta = flows[0]?.pregunta || flows[0]?.mensaje || '¿Cómo puedo ayudarte?';
    const opciones = flows[0].opciones.map((op: any, i: number) =>
      `${i + 1}️⃣ ${op.texto || `Opción ${i + 1}`}`).join('\n');
  
    let menu = `💡 ${pregunta}\n${opciones}\n\nResponde con el número de la opción que deseas.`;
  
    if (idiomaDestino !== 'es') {
      try { menu = await traducirMensaje(menu, idiomaDestino); } catch {}
    }
  
    await enviarWhatsAppSeguro(fromNumber, menu, tenant.id);
    console.log("📬 Menú enviado desde Flujos Guiados Interactivos.");
    return;
  }  

  const nrm = (t: string) =>
    (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  
  const nUser = nrm(mensajeUsuario);

  const saludoCorto = ["hola","buenas","hello","hi","hey"];
  // Solo considerar saludo si el mensaje ENTERO es un saludo corto
  if (saludoCorto.includes(mensajeUsuario)) {
    respuesta = getBienvenidaPorCanal('whatsapp', tenant, idiomaDestino);
  }
  
  // ✅ Detector robusto para “pedir info”, cubre “inf”, “mas info”, etc.
  const esPedirInfo =
    /\bmas\s*info\b/.test(nUser) ||         // "mas info" / "más info" (ya normalizado)
    /\binfo\b/.test(nUser) ||               // contiene "info"
    /\binf\b/.test(nUser) ||                // SOLO "inf"
    /\bquiero\s+mas\b/.test(nUser) ||       // "quiero mas ..."
    nUser.endsWith(' inf') ||               // termina en " inf"
    nUser.includes('quiero informacion') ||
    nUser.includes('mas informacion');

  // 🧠 Flujos guiados (si mensaje es "quiero info", "más información", etc.)
  const keywordsInfo = [
    'quiero informacion',
    'más información',
    'mas informacion',
    'info',
    'necesito informacion',
    'deseo informacion',
    'quiero saber',
    'me puedes decir',
    'quiero saber mas',
    'i want info',
    'i want information',
    'more info',
    'more information',
    'tell me more',
    'inf'
  ];

  if (esPedirInfo || keywordsInfo.some(k => nUser.includes(nrm(k)))) {
    const flow = flows[0];
    if (flow?.opciones?.length > 0) {
  
      // 🛑 Verificar estado antes de enviar menú
      const { rows: estadoRows } = await pool.query(
        `SELECT estado FROM clientes WHERE tenant_id = $1 AND contacto = $2 LIMIT 1`,
        [tenant.id, fromNumber]
      );
      const estadoActual = estadoRows[0]?.estado || null;
  
      if (estadoActual === 'menu_enviado') {
        console.log("⚠️ Menú ya enviado, no se reenviará.");
        return;
      }
  
      const pregunta = flow.pregunta || flow.mensaje || '¿Cómo puedo ayudarte?';
      const opciones = flow.opciones
        .map((op: any, i: number) => `${i + 1}️⃣ ${op.texto || `Opción ${i + 1}`}`)
        .join('\n');
  
      let menu = `💡 ${pregunta}\n${opciones}\n\nResponde con el número de la opción que deseas.`;
  
      if (idiomaDestino !== 'es') {
        try {
          menu = await traducirMensaje(menu, idiomaDestino);
        } catch (e) {
          console.warn('No se pudo traducir el menú, se enviará en ES:', e);
        }
      }
  
      await enviarWhatsAppSeguro(fromNumber, menu, tenant.id);
  
      // 🔹 Guardar estado para no reenviar hasta que responda
      await pool.query(
        `UPDATE clientes SET estado = 'menu_enviado'
         WHERE tenant_id = $1 AND contacto = $2`,
        [tenant.id, fromNumber]
      );
  
      console.log("📬 Menú personalizado enviado desde Flujos Guiados Interactivos.");
      return;
    }
  }  

  // ✅ Selección numérica robusta (1,2,3...) desde el Body crudo
  const rawBody = (body.Body ?? '').toString();
  const digitOnly = rawBody.replace(/[^\p{N}]/gu, '').trim(); // deja solo dígitos (Unicode-safe)

  console.log('🔢 Selección recibida:',
    { rawBody, digitOnly, len: digitOnly.length, charCodes: [...rawBody].map(c => c.charCodeAt(0)) }
  );

  if (
    digitOnly.length === 1 &&
    Array.isArray(flows[0]?.opciones) &&
    flows[0].opciones.length
  ) {
    const n = Number(digitOnly);
    const opcionesNivel1 = flows[0].opciones;

    if (Number.isInteger(n) && n >= 1 && n <= opcionesNivel1.length) {
      const opcionSeleccionada = opcionesNivel1[n - 1];

    // 1) Respuesta directa
    if (opcionSeleccionada?.respuesta) {
      let out = opcionSeleccionada.respuesta;
      try {
        const idiomaOut = await detectarIdioma(out);
        if (idiomaOut && idiomaOut !== 'zxx' && idiomaOut !== idiomaDestino) {
          out = await traducirMensaje(out, idiomaDestino);
        }
      } catch (e) {
        // 📌 Agregar recordatorio al final
        out += "\n\n💡 ¿Quieres ver otra opción del menú? Responde con el número correspondiente.";
        console.warn('No se pudo traducir la respuesta de la opción:', e);
      }

      await enviarWhatsAppSeguro(fromNumber, out, tenant.id);
      await pool.query(
        `INSERT INTO messages (tenant_id, role, content, timestamp, canal)
         VALUES ($1, 'assistant', $2, NOW(), $3)`,
        [tenant.id, out, canal]
      );
      console.log("📬 Respuesta enviada desde opción seleccionada del menú");

      // 🔹 Resetear estado para permitir mostrar menú en el futuro
      await pool.query(
        `UPDATE clientes SET estado = 'fuera_menu'
         WHERE tenant_id = $1 AND contacto = $2`,
        [tenant.id, fromNumber]
      );

      console.log("🔄 Estado de conversación reseteado a 'fuera_menu'");
      return;
    }

    // 1.5) Submenú "terminal": solo mensaje sin opciones
    if (opcionSeleccionada?.submenu && !opcionSeleccionada?.submenu?.opciones?.length) {
      let out = opcionSeleccionada.submenu.mensaje || '';
      if (out) {
        try {
          const langOut = await detectarIdioma(out);
          if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
            out = await traducirMensaje(out, idiomaDestino);
          }
        } catch {}
        await enviarWhatsAppSeguro(fromNumber, out, tenant.id);
        await pool.query(
          `INSERT INTO messages (tenant_id, role, content, timestamp, canal)
          VALUES ($1, 'assistant', $2, NOW(), $3)`,
          [tenant.id, out, canal]
        );
        console.log("📬 Mensaje enviado desde submenú terminal.");
        return;
      }
    }

    // 2) Submenú
    if (opcionSeleccionada?.submenu?.opciones?.length) {
      const titulo = opcionSeleccionada.submenu.mensaje || 'Elige una opción:';
      const opcionesSm = opcionSeleccionada.submenu.opciones
        .map((op: any, i: number) => `${i + 1}️⃣ ${op.texto || `Opción ${i + 1}`}`)
        .join('\n');

      let menuSm = `💡 ${titulo}\n${opcionesSm}\n\nResponde con el número de la opción que deseas.`;
      try {
        const idMenu = await detectarIdioma(menuSm);
        if (idMenu && idMenu !== 'zxx' && idMenu !== idiomaDestino) {
          menuSm = await traducirMensaje(menuSm, idiomaDestino);
        }
      } catch (e) {
        console.warn('No se pudo traducir el submenú:', e);
      }

      await enviarWhatsAppSeguro(fromNumber, menuSm, tenant.id);
      console.log("📬 Submenú enviado.");
      return;
    }

        // ⚠️ Opción válida pero sin contenido: reenvía el menú y sal
        if (flows[0]?.opciones?.length) {
          const pregunta = flows[0].pregunta || flows[0].mensaje || '¿Cómo puedo ayudarte?';
          const opciones = flows[0].opciones
            .map((op: any, i: number) => `${i + 1}️⃣ ${op.texto || `Opción ${i + 1}`}`)
            .join('\n');
    
          let menu = `⚠️ Esa opción aún no tiene contenido. Elige otra.\n\n💡 ${pregunta}\n${opciones}\n\nResponde con el número de la opción que deseas.`;
    
          try {
            if (idiomaDestino !== 'es') {
              menu = await traducirMensaje(menu, idiomaDestino);
            }
          } catch (e) {
            console.warn('No se pudo traducir el menú (opción sin contenido), se enviará en ES:', e);
          }
    
          await enviarWhatsAppSeguro(fromNumber, menu, tenant.id);
        }
        return; // 👈 evita caer a FAQs/IA
    
      } else {
        console.log("⚠️ Selección no válida o no hay opciones cargadas.");
      
        if (flows[0]?.opciones?.length) {
          const pregunta = flows[0].pregunta || flows[0].mensaje || '¿Cómo puedo ayudarte?';
          const opciones = flows[0].opciones
            .map((op: any, i: number) => `${i + 1}️⃣ ${op.texto || `Opción ${i + 1}`}`)
            .join('\n');
        
          let menu = `⚠️ Opción no válida. Intenta de nuevo.\n\n💡 ${pregunta}\n${opciones}\n\nResponde con el número de la opción que deseas.`;
        
          try {
            if (idiomaDestino !== 'es') {
              menu = await traducirMensaje(menu, idiomaDestino);
            }
          } catch {}
        
          await enviarWhatsAppSeguro(fromNumber, menu, tenant.id);
        }
        return;
      }      
}

// 🔎 Interceptor canal-agnóstico (recomendación principiantes)
const interceptado = await runBeginnerRecoInterceptor({
  tenantId: tenant.id,
  canal: 'whatsapp',
  fromNumber,
  userInput,
  idiomaDestino,
  intencionParaFaq,
  promptBase,
  enviarFn: enviarWhatsAppSeguro, // tu sender chunker
});

if (interceptado) {
  // ya respondió + registró sugerida + (opcional) follow-up se maneja afuera si quieres
  // Si quieres mantener tu follow-up actual aquí, puedes dejarlo después de este if.
  console.log('✅ Interceptor principiantes respondió en WhatsApp.');
  return; // evita FAQ genérica
}

  // [REPLACE] lookup robusto
  let respuestaDesdeFaq: string | null = null;

  if (isDirectIntent(intencionParaFaq, INTENTS_DIRECT)) {
    if (intencionParaFaq === 'precio') {
      // 🔎 Usa helper robusto para precios (alias + sub-slugs)
      respuestaDesdeFaq = await fetchFaqPrecio(tenant.id, canal);
      if (respuestaDesdeFaq) {
        console.log('📚 FAQ precio (robusta) encontrada.');
      }
    } else {
      // Camino normal para otras intenciones directas
      const { rows: faqPorIntencion } = await pool.query(
        `SELECT respuesta FROM faqs 
        WHERE tenant_id = $1 AND canal = $2 AND LOWER(intencion) = LOWER($3) LIMIT 1`,
        [tenant.id, canal, intencionParaFaq]
      );
      if (faqPorIntencion.length > 0) {
        respuestaDesdeFaq = faqPorIntencion[0].respuesta;
      }
    }
  }

  if (respuestaDesdeFaq) {
    // Traducir si hace falta
    let out = respuestaDesdeFaq;
    const idiomaRespuesta = await detectarIdioma(out);
    if (idiomaRespuesta && idiomaRespuesta !== 'zxx' && idiomaRespuesta !== idiomaDestino) {
      out = await traducirMensaje(out, idiomaDestino);
    }
    respuesta = out;

    console.log(`✅ Respuesta tomada desde FAQ oficial por intención: "${intencionParaFaq}"`);
    console.log("📚 FAQ utilizada:", respuestaDesdeFaq);

    await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
      VALUES ($1, 'user', $2, NOW(), $3, $4, $5)`,
      [tenant.id, userInput, canal, fromNumber || "anónimo", messageId]
    );
    await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
      VALUES ($1, 'assistant', $2, NOW(), $3, $4)`,
      [tenant.id, respuesta, canal, fromNumber || 'anónimo']
    );

    await enviarWhatsAppSeguro(fromNumber, respuesta, tenant.id);
    console.log("📬 Respuesta enviada vía Twilio (desde FAQ oficial):", respuesta);

    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT DO NOTHING`,
      [tenant.id, canal, messageId]
    );

    // Inteligencia + follow-up (único, configurable)
    try {
      // Solo usamos el detector para el nivel; la intención ya está canónica
      const det = await detectarIntencion(userInput, tenant.id, 'whatsapp');
      const nivelFaq = det?.nivel_interes ?? 1;
      const intFinal = (INTENCION_FINAL_CANONICA || '').toLowerCase();

      const intencionesCliente = [
        "comprar","compra","pagar","agendar","reservar","confirmar","interes_clases","precio"
      ];
      if (intencionesCliente.some(p => intFinal.includes(p))) {
        await pool.query(
          `UPDATE clientes
            SET segmento = 'cliente'
          WHERE tenant_id = $1 AND contacto = $2
            AND (segmento = 'lead' OR segmento IS NULL)`,
          [tenant.id, fromNumber]
        );
      }

      await pool.query(
        `INSERT INTO sales_intelligence
          (tenant_id, contacto, canal, mensaje, intencion, nivel_interes, message_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (tenant_id, contacto, canal, message_id) DO NOTHING`,
        [tenant.id, fromNumber, canal, userInput, intFinal, nivelFaq, messageId]
      );

      const intencionesFollowUp = ["interes_clases","reservar","precio","comprar","horario"];
      if (nivelFaq >= 3 || intencionesFollowUp.includes(intFinal)) {
        // ... tu scheduling actual sin cambios
      }
    } catch (e) {
      console.warn('⚠️ No se pudo registrar/schedule tras FAQ oficial:', e);
    }

    return; // salir aquí si hubo FAQ directa
  }

// Si NO hubo FAQ directa → similaridad
{
  const mensajeTraducido = (idiomaDestino !== 'es')
    ? await traducirMensaje(mensajeUsuario, 'es')
    : mensajeUsuario;

  respuesta =
    await buscarRespuestaSimilitudFaqsTraducido(faqs, mensajeTraducido, idiomaDestino) ||
    await buscarRespuestaDesdeFlowsTraducido(flows, mensajeTraducido, idiomaDestino);
}

// 🔒 Protección adicional: si ya respondió con FAQ oficial, no continuar
if (respuestaDesdeFaq) {
  console.log("🔒 Ya se respondió con una FAQ oficial. Se cancela generación de sugerida.");
  return;
}

// ⛔ No generes sugeridas si el mensaje NO tiene letras (p.ej. "8") o es muy corto
const hasLetters = /\p{L}/u.test(userInput);
if (!hasLetters || normalizarTexto(userInput).length < 4) {
  console.log('🧯 No se genera sugerida (sin letras o texto muy corto).');
  return;
}

// 🧠 Si no hay respuesta aún, generar con OpenAI y registrar como FAQ sugerida
if (!respuestaDesdeFaq && !respuesta) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

  const completion = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [
      { role: 'system', content: promptBase },
      { role: 'user', content: userInput },
    ],
  });

  respuesta = completion.choices[0]?.message?.content?.trim()
          || getBienvenidaPorCanal('whatsapp', tenant, idiomaDestino);

  const respuestaGenerada = respuesta;

  // 🌐 Asegurar idioma del cliente
  try {
    const idiomaRespuesta = await detectarIdioma(respuesta);
  if (idiomaRespuesta && idiomaRespuesta !== 'zxx' &&
      idiomaRespuesta !== idiomaDestino) {
    respuesta = await traducirMensaje(respuesta, idiomaDestino);
  }

  } catch (e) {
    console.warn('No se pudo traducir la respuesta de OpenAI:', e);
  }

  const respuestaGeneradaLimpia = respuesta;
  const preguntaNormalizada = normalizarTexto(userInput);
  const respuestaNormalizada = respuestaGeneradaLimpia.trim();

  let sugeridasExistentes: any[] = [];
  try {
    const sugeridasRes = await pool.query(
      'SELECT id, pregunta, respuesta_sugerida FROM faq_sugeridas WHERE tenant_id = $1 AND canal = $2',
      [tenant.id, canal]
    );
    sugeridasExistentes = sugeridasRes.rows || [];
  } catch (error) {
    console.error('⚠️ Error consultando FAQ sugeridas:', error);
  }

  // Verificación de duplicados
  const yaExisteSugerida = yaExisteComoFaqSugerida(
    userInput,
    respuestaGenerada,
    sugeridasExistentes
  );

  const yaExisteAprobada = yaExisteComoFaqAprobada(
    userInput,
    respuestaGenerada,
    faqs
  );

  if (yaExisteSugerida || yaExisteAprobada) {
    if (yaExisteSugerida) {
      await pool.query(
        `UPDATE faq_sugeridas 
         SET veces_repetida = veces_repetida + 1, ultima_fecha = NOW()
         WHERE id = $1`,
        [yaExisteSugerida.id]
      );
      console.log(`⚠️ Pregunta similar ya sugerida (ID: ${yaExisteSugerida.id})`);
    } else {
      console.log(`⚠️ Pregunta ya registrada como FAQ oficial.`);
    }
  } else {
    // 🧠 Detectar intención para evitar duplicados semánticos
    const textoTraducidoParaGuardar = idioma !== 'es'
    ? await traducirMensaje(userInput, 'es')
    : userInput;

    // [REPLACE] Normaliza "duda" a sub-slug antes de guardar la sugerida
    const { intencion: intencionDetectadaParaGuardar } =
    await detectarIntencion(textoTraducidoParaGuardar, tenant.id, 'whatsapp');

    let intencionFinal = intencionDetectadaParaGuardar.trim().toLowerCase();
    if (intencionFinal === 'duda') {
      intencionFinal = buildDudaSlug(userInput);
    }
    intencionFinal = normalizeIntentAlias(intencionFinal); // 👈 CANONICALIZA AQUÍ

    const { rows: sugeridasConIntencion } = await pool.query(
    `SELECT intencion FROM faq_sugeridas 
    WHERE tenant_id = $1 AND canal = $2 AND procesada = false`,
    [tenant.id, canal]
    );

    const { rows: faqsOficiales } = await pool.query(
    `SELECT intencion FROM faqs 
    WHERE tenant_id = $1 AND canal = $2`,
    [tenant.id, canal]
    );

    // 🧠 Compara intención detectada con las oficiales (aplica unicidad solo a INTENT_UNIQUE)
    const enforzaUnicidad = INTENT_UNIQUE.has(intencionFinal);

    const yaExisteIntencionOficial = faqsOficiales.some(faq =>
      (faq.intencion || '').trim().toLowerCase() === intencionFinal
    );

    if (enforzaUnicidad && yaExisteIntencionOficial) {
      console.log(`⚠️ Ya existe una FAQ oficial con la intención "${intencionFinal}" para este canal y tenant. No se guardará.`);
    } else {
      const yaExisteIntencion = sugeridasConIntencion.some(faq =>
        (faq.intencion || '').trim().toLowerCase() === intencionFinal
      );

      if (enforzaUnicidad && yaExisteIntencion) {
        console.log(`⚠️ Ya existe una FAQ sugerida con la intención "${intencionFinal}" para este canal y tenant. No se guardará.`);
        // 🚫 No hacer return aquí
      } else {
        // ✅ Insertar la sugerencia (para intenciones no-únicas como "duda", se permite múltiples)
        await pool.query(
          `INSERT INTO faq_sugeridas (tenant_id, canal, pregunta, respuesta_sugerida, idioma, procesada, ultima_fecha, intencion)
          VALUES ($1, $2, $3, $4, $5, false, NOW(), $6)`,
          [tenant.id, canal, preguntaNormalizada, respuestaNormalizada, idioma, intencionFinal]
        );
        console.log(`📝 Pregunta no resuelta registrada: "${preguntaNormalizada}"`);
      }
    }
  }
    const tokensConsumidos = completion.usage?.total_tokens || 0;
    if (tokensConsumidos > 0) {
      await pool.query(
        `UPDATE uso_mensual SET usados = usados + $1 WHERE tenant_id = $2 AND canal = 'tokens_openai' AND mes = date_trunc('month', CURRENT_DATE)`,
        [tokensConsumidos, tenant.id]
      );
    }
  }  

  await pool.query(
    `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
    VALUES ($1, 'user', $2, NOW(), $3, $4, $5)`,
    [tenant.id, userInput, canal, fromNumber || "anónimo", messageId]
  );

  // ✅ Incrementar solo una vez por mensaje recibido
  // 🔍 Obtiene membresia_inicio
  const { rows: rowsTenant } = await pool.query(
    `SELECT membresia_inicio FROM tenants WHERE id = $1`, [tenant.id]
  );
  const membresiaInicio = rowsTenant[0]?.membresia_inicio;
  if (!membresiaInicio) {
    console.error('❌ No se encontró membresia_inicio para el tenant:', tenant.id);
    return; // O maneja el error de forma adecuada
  }

  // 🔥 Calcula el ciclo de membresía actual
  const inicio = new Date(membresiaInicio);
  const ahora = new Date();
  const diffInMonths = Math.floor(
    (ahora.getFullYear() - inicio.getFullYear()) * 12 + (ahora.getMonth() - inicio.getMonth())
  );
  const cicloInicio = new Date(inicio);
  cicloInicio.setMonth(inicio.getMonth() + diffInMonths);

  // 📅 Asegura que la fecha se trunque a YYYY-MM-DD
  const cicloMes = cicloInicio.toISOString().split('T')[0];

  // 📝 Log detallado antes de la inserción
  console.log(`🔄 Intentando insertar/actualizar uso_mensual para tenant: ${tenant.id}, canal: ${canal}, cicloMes: ${cicloMes}`);

  try {
    const result = await pool.query(
      `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
      VALUES ($1, $2, $3, 1)
      ON CONFLICT (tenant_id, canal, mes) DO UPDATE SET usados = uso_mensual.usados + 1
      RETURNING *`,
      [tenant.id, canal, cicloMes]
    );

    console.log(`✅ Registro actualizado/insertado en uso_mensual:`, result.rows[0]);
  } catch (error) {
    console.error(`❌ Error al actualizar uso_mensual para tenant ${tenant.id}, canal ${canal}:`, error);
  }

  // Insertar mensaje bot (esto no suma a uso)
  await pool.query(
    `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
    VALUES ($1, 'assistant', $2, NOW(), $3, $4)`,
    [tenant.id, respuesta, canal, fromNumber || 'anónimo']
  );  

  await enviarWhatsAppSeguro(fromNumber, respuesta, tenant.id);
  console.log("📬 Respuesta enviada vía Twilio:", respuesta);

  await pool.query(
    `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT DO NOTHING`,
    [tenant.id, canal, messageId]
  );  

  try {
    const det = await detectarIntencion(userInput, tenant.id, 'whatsapp');
    const nivel_interes = det?.nivel_interes ?? 1;
    const intFinal = (INTENCION_FINAL_CANONICA || '').toLowerCase();
    const textoNormalizado = userInput.trim().toLowerCase();
  
    console.log(`🔎 Intención (final) = ${intFinal}, Nivel de interés: ${nivel_interes}`);
  
    // 🛑 No registrar si es saludo puro
    const saludos = ["hola", "buenas", "buenos días", "buenas tardes", "buenas noches", "hello", "hi", "hey"];
    if (saludos.includes(textoNormalizado)) {
      console.log("⚠️ Mensaje ignorado por ser saludo.");
      return;
    }
  
    // 🔥 Segmentación con intención final
    const intencionesCliente = [
      "comprar", "compra", "pagar", "agendar", "reservar", "confirmar",
      "interes_clases", "precio"
    ];
    if (intencionesCliente.some(p => intFinal.includes(p))) {
      await pool.query(
        `UPDATE clientes
            SET segmento = 'cliente'
          WHERE tenant_id = $1
            AND contacto = $2
            AND (segmento = 'lead' OR segmento IS NULL)`,
        [tenant.id, fromNumber]
      );
    }
  
    // 🔥 Registrar en sales_intelligence con intención final
    await pool.query(
      `INSERT INTO sales_intelligence
        (tenant_id, contacto, canal, mensaje, intencion, nivel_interes, message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, contacto, canal, message_id) DO NOTHING`,
      [tenant.id, fromNumber, canal, userInput, intFinal, nivel_interes, messageId]
    );
  
    // 🚀 Follow-up con intención final
    const intencionesFollowUp = ["interes_clases", "reservar", "precio", "comprar", "horario"];
    if (nivel_interes >= 3 || intencionesFollowUp.includes(intFinal)) {
      const configRes = await pool.query(
        `SELECT * FROM follow_up_settings WHERE tenant_id = $1`,
        [tenant.id]
      );
      const config = configRes.rows[0];
  
      if (config) {
        let mensajeSeguimiento = config.mensaje_general || "¡Hola! ¿Te gustaría que te ayudáramos a avanzar?";
        if (intFinal.includes("precio") && config.mensaje_precio) {
          mensajeSeguimiento = config.mensaje_precio;
        } else if ((intFinal.includes("agendar") || intFinal.includes("reservar")) && config.mensaje_agendar) {
          mensajeSeguimiento = config.mensaje_agendar;
        } else if ((intFinal.includes("ubicacion") || intFinal.includes("location")) && config.mensaje_ubicacion) {
          mensajeSeguimiento = config.mensaje_ubicacion;
        }
  
        try {
          const idiomaMensaje = await detectarIdioma(mensajeSeguimiento);
          if (idiomaMensaje && idiomaMensaje !== 'zxx' && idiomaMensaje !== idiomaDestino) {
            mensajeSeguimiento = await traducirMensaje(mensajeSeguimiento, idiomaDestino);
          }
        } catch {}
  
        await pool.query(
          `DELETE FROM mensajes_programados
           WHERE tenant_id = $1 AND canal = $2 AND contacto = $3 AND enviado = false`,
          [tenant.id, canal, fromNumber]
        );
  
        const delayMin = getConfigDelayMinutes(config, 60);
        const fechaEnvio = new Date();
        fechaEnvio.setMinutes(fechaEnvio.getMinutes() + delayMin);
  
        await pool.query(
          `INSERT INTO mensajes_programados (tenant_id, canal, contacto, contenido, fecha_envio, enviado)
           VALUES ($1, $2, $3, $4, $5, false)`,
          [tenant.id, canal, fromNumber, mensajeSeguimiento, fechaEnvio]
        );
  
        console.log(`📅 Follow-up programado en ${delayMin} min (~${(delayMin/60).toFixed(1)} h) para ${fromNumber} (${idiomaDestino})`);
      }
    }
  } catch (err) {
    console.error("⚠️ Error en inteligencia de ventas o seguimiento:", err);
  }   
  } 
} 
