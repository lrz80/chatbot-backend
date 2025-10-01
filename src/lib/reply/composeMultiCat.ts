// backend/src/lib/reply/composeMultiCat.ts
type Links = {
  memberships?: string;
  classes?: string;
  contact?: string;
};

export function composePricingReserveMessage(opts: {
  cats: string[];
  links: Links;
  hasDuoPlan?: boolean; // si tu prompt/tenant lo define, pásalo true
}) {
  const { cats, links, hasDuoPlan } = opts;

  const blocks: string[] = [];
  const intro = '¡Hola! 😊\nTe respondo ambas cosas:';
  const outro = '¿Quieres que te recomiende el plan según cuántas veces entrenan por semana?';

  // PRICING
  if (cats.includes('PRICING')) {
    if (hasDuoPlan) {
      blocks.push(
        'Sí, contamos con opción para dos personas. Revisa los detalles:' +
        (links.memberships ? `\n• Planes y precios: ${links.memberships}` : '')
      );
    } else {
      blocks.push(
        'Por ahora no contamos con un plan “para dos personas”. Cada persona puede elegir su membresía o créditos.' +
        (links.memberships ? `\n• Planes y precios: ${links.memberships}` : '')
      );
    }
  }

  // RESERVE
  if (cats.includes('RESERVE')) {
    blocks.push(
      'Nuestro horario funciona por reserva previa:' +
      (links.classes ? `\n• Calendario y reservas: ${links.classes}` : '')
    );
  }

  // Fallback útil si no hay links claros
  if (blocks.length === 0) {
    blocks.push(
      'Puedo ayudarte con planes y reservas.' +
      (links.contact ? `\n• Contáctanos: ${links.contact}` : '')
    );
  }

  return [intro, ...blocks, outro].join('\n\n');
}
