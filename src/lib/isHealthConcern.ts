// src/lib/isHealthConcern.ts

/**
 * Detecta si el mensaje del usuario parece hablar de
 * problemas de salud, dolor, síntomas, lesiones o condiciones médicas.
 *
 * Es genérico para cualquier tipo de negocio (gym, estética, restaurante, etc.).
 */
export function isHealthConcern(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();

  const keywords = [
    // ES - síntomas / problemas
    'mancha', 'manchas', 'irritacion', 'irritación', 'sarpullido',
    'granos', 'acne', 'acné', 'alergia', 'alergias',
    'picazon', 'picazón', 'comezon', 'comezón',
    'ardor', 'inflamacion', 'inflamación',
    'dolor', 'duelen', 'me duele', 'lastime', 'lastimé',
    'lesion', 'lesión', 'lesionado', 'lesionada',
    'fractura', 'torcedura', 'esguince',
    'sangrado', 'sangra', 'sangrando',
    'infeccion', 'infección', 'pus',
    'hinchado', 'hinchada', 'hinchazon', 'hinchazón',
    'fiebre', 'mareo', 'mareos', 'nauseas', 'náuseas',

    // ES - contexto médico / diagnóstico
    'diagnostico', 'diagnóstico', 'enfermedad', 'enfermo', 'enferma',
    'condicion medica', 'condición médica',
    'problema de salud', 'problemas de salud',
    'es seguro entrenar', 'es seguro hacer ejercicio',
    'embarazada', 'embarazo',

    // EN - síntomas / problemas
    'rash', 'spots', 'irritation', 'irritated',
    'pimples', 'acne', 'allergy', 'allergies',
    'itch', 'itchy', 'itching', 'burning',
    'swollen', 'swelling',
    'pain', 'hurts', 'hurt', 'sore',
    'injury', 'injured', 'fracture', 'sprain', 'strain',
    'bleeding', 'bleeds', 'infection', 'pus',
    'fever', 'dizzy', 'dizziness', 'nausea', 'nauseous',

    // EN - contexto médico / diagnóstico
    'medical condition', 'health condition',
    'diagnosis', 'diagnose',
    'is it safe to', 'is it safe for me to',
    'can i work out with', 'can i exercise with',
    'pregnant'
  ];

  // Si alguna palabra clave aparece, lo consideramos tema de salud
  if (keywords.some(k => t.includes(k))) return true;

  // Algunos patrones típicos de "es seguro si tengo X"
  const patterns: RegExp[] = [
    /es seguro .*si tengo/i,
    /es malo .*si tengo/i,
    /puedo entrenar .*si tengo/i,
    /puedo hacer ejercicio .*si tengo/i,
    /is it safe .*if i have/i,
    /can i .* if i have/i
  ];

  return patterns.some(re => re.test(t));
}
