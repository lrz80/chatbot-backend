// src/lib/recoPrincipiantes/construirMensaje.ts
import OpenAI from 'openai';
import { TipoClase } from './tiposClases';

function orderForBeginner(arr: TipoClase[]) {
  const ib = (x?: string) => x === 'baja' ? 0 : x === 'media' ? 1 : 2;
  return arr.slice().sort((a,b) => {
    const ai = ib(a.intensidad); const bi = ib(b.intensidad);
    if (ai !== bi) return ai - bi;
    const ad = a.duracion_min ?? 999, bd = b.duracion_min ?? 999;
    return ad - bd;
  });
}

export async function buildBeginnerRecoMessage(
  tipos: TipoClase[],
  promptBase: string,
  idioma: 'es'|'en'
): Promise<string> {
  const hasCycling = tipos.some(t => (t.tipo || '').toLowerCase().includes('cycling'));
  const hasFunc    = tipos.some(t => /(funcional|functional)/i.test(t.tipo || ''));

  const beginners = tipos.filter(t =>
    t.beginner || /beginner|intro|b(á|a)sico|nivel\s*1/i.test(`${t.nivel||''} ${t.nombre||''}`)
  );

  const pick = (filter: (t: TipoClase)=>boolean) => {
    const cands = orderForBeginner(beginners.filter(filter));
    if (cands.length) return cands[0];
    const fallback = orderForBeginner(tipos.filter(filter));
    return fallback[0];
  };

  const recoCycling = hasCycling ? pick(t => (t.tipo||'').toLowerCase().includes('cycling')) : undefined;
  const recoFunc    = hasFunc    ? pick(t => /(funcional|functional)/i.test(t.tipo || ''))   : undefined;

  const plain = ((): string => {
    if (idioma === 'en') {
      let base = `For first-timers, we usually recommend starting with a lower-intensity or “Beginner/Level 1” option to learn form and pacing comfortably.`;
      if (recoCycling && recoFunc) {
        base += `\n\n• If you prefer low-impact cardio with music: ${recoCycling.nombre || 'Cycling (Beginner)'} (${recoCycling.duracion_min ?? 45} min).`;
        base += `\n• If you want full-body and strength: ${recoFunc.nombre || 'Functional (Beginner)'} (${recoFunc.duracion_min ?? 45} min).`;
      } else if (recoCycling) {
        base += `\n\n• Recommended: ${recoCycling.nombre || 'Cycling (Beginner)'} (${recoCycling.duracion_min ?? 45} min).`;
      } else if (recoFunc) {
        base += `\n\n• Recommended: ${recoFunc.nombre || 'Functional (Beginner)'} (${recoFunc.duracion_min ?? 45} min).`;
      }
      base += `\n\nTell me your current fitness level and I’ll point you to the best fit.`;
      return base;
    } else {
      let base = `Para quienes empiezan, solemos sugerir una opción de menor intensidad o “Nivel 1 / Principiantes” para aprender técnica y ritmo con comodidad.`;
      if (recoCycling && recoFunc) {
        base += `\n\n• Si prefieres cardio de bajo impacto con música: ${recoCycling.nombre || 'Cycling (Principiantes)'} (${recoCycling.duracion_min ?? 45} min).`;
        base += `\n• Si quieres cuerpo completo y fuerza: ${recoFunc.nombre || 'Funcional (Principiantes)'} (${recoFunc.duracion_min ?? 45} min).`;
      } else if (recoCycling) {
        base += `\n\n• Recomendado: ${recoCycling.nombre || 'Cycling (Principiantes)'} (${recoCycling.duracion_min ?? 45} min).`;
      } else if (recoFunc) {
        base += `\n\n• Recomendado: ${recoFunc.nombre || 'Funcional (Principiantes)'} (${recoFunc.duracion_min ?? 45} min).`;
      }
      base += `\n\nSi me dices tu nivel actual, te indico la mejor opción.`;
      return base;
    }
  })();

  // Redacción breve usando promptBase (opcional, seguro).
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
    const clasesJson = JSON.stringify(tipos);
    const system = `${promptBase}\n\nActúa como el asistente del estudio. Escribe en ${idioma}. Responde en 2–3 frases, claro y amable, recomendando PRIMERA CLASE usando los datos (JSON) y manteniendo el tono de marca.`;
    const user = `Cliente: “¿Cuál recomiendas si nunca ha hecho ninguna?”\nDatos de clases (JSON): ${clasesJson}`;
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      temperature: 0.3,
      max_tokens: 220,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
        { role: 'assistant', content: plain } // guía/fallback
      ]
    });
    const out = completion.choices[0]?.message?.content?.trim();
    if (out) return out;
  } catch {
    /* si falla, usa plain */
  }

  return plain;
}
