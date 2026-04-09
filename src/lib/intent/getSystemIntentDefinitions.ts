import type { IntentDefinition } from "./types";

export async function getSystemIntentDefinitions(): Promise<IntentDefinition[]> {
  return [
    {
      key: "saludo",
      description: "saludo puro o apertura conversacional sin pedido claro",
      examples: [],
      source: "system",
    },
    {
      key: "precio",
      description: "pregunta enfocada en precios, costos, tarifas o cotización",
      examples: [],
      source: "system",
    },
    {
      key: "horario",
      description: "pregunta enfocada en horarios u horas de atención",
      examples: [],
      source: "system",
    },
    {
      key: "ubicacion",
      description: "pregunta enfocada en dirección o ubicación",
      examples: [],
      source: "system",
    },
    {
      key: "disponibilidad",
      description: "pregunta enfocada en disponibilidad, cupos, fechas o stock",
      examples: [],
      source: "system",
    },
    {
      key: "agendar",
      description: "intención de reservar, agendar o concretar cita",
      examples: [],
      source: "system",
    },
    {
      key: "clase_prueba",
      description: "intención de clase de prueba, sesión introductoria o trial",
      examples: [],
      source: "system",
    },
    {
      key: "pago",
      description: "intención de pagar, activar, suscribirse o completar checkout",
      examples: [],
      source: "system",
    },
    {
      key: "cancelar",
      description: "intención de cancelar algo no relacionado a soporte de reserva",
      examples: [],
      source: "system",
    },
    {
      key: "soporte",
      description: "ayuda, problema técnico u operativo",
      examples: [],
      source: "system",
    },
    {
      key: "queja",
      description: "molestia, reclamo o insatisfacción",
      examples: [],
      source: "system",
    },
    {
      key: "info_general",
      description:
        "vista general del negocio, servicios principales u oferta general sin entidad concreta",
      examples: [],
      source: "system",
    },
    {
      key: "info_servicio",
      description:
        "consulta sobre un servicio, plan, paquete, producto o variante concreta",
      examples: [],
      source: "system",
    },
    {
      key: "no_interesado",
      description: "rechazo claro o desinterés",
      examples: [],
      source: "system",
    },
    {
      key: "duda",
      description: "mensaje ambiguo o insuficiente",
      examples: [],
      source: "system",
    },
    {
      key: "soporte_reserva",
      description:
        "cambio, cancelación o problema relacionado con una reserva o cita existente",
      examples: [],
      source: "system",
    },
  ];
}