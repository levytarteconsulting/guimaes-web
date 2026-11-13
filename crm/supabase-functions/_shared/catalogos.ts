// Catálogos del CRM para las Edge Functions (hoy, el agente).
//
// La fuente de verdad sigue siendo crm/data.js (el CRM los usa desde ahí y la
// base de datos no los guarda). Esto es una copia: catalogos_test.ts falla si
// difiere de crm/data.js, así que al cambiar un catálogo en el CRM hay que
// cambiarlo también aquí.

export type Servicio = { id: string; nombre: string; frecuencia: string };
export type Etapa = { id: string; etiqueta: string; fase: string };
export type Opcion = { id: string; etiqueta: string };

export const SERVICIOS: readonly Servicio[] = [
  { id: "s1", nombre: "CFO Externo", frecuencia: "mensual" },
  { id: "s2", nombre: "Planificación Fiscal", frecuencia: "anual" },
  { id: "s3", nombre: "Asesoría Contable", frecuencia: "mensual" },
  { id: "s4", nombre: "Asesoría Laboral", frecuencia: "mensual" },
  { id: "s5", nombre: "Legal y Cumplimiento", frecuencia: "puntual" },
  { id: "s6", nombre: "Planificación Estratégica", frecuencia: "puntual" },
  { id: "s7", nombre: "Expansión LatAm", frecuencia: "puntual" },
];

export const ETAPAS: readonly Etapa[] = [
  { id: "nueva_solicitud", etiqueta: "Nueva solicitud", fase: "Captación" },
  { id: "contactado", etiqueta: "Contactado", fase: "Captación" },
  { id: "reunion", etiqueta: "Reunión", fase: "Cualificación" },
  { id: "propuesta", etiqueta: "Propuesta enviada", fase: "Cualificación" },
  { id: "negociacion", etiqueta: "Negociación", fase: "Cierre" },
  { id: "cliente_activo", etiqueta: "Cliente activo", fase: "Cierre" },
  { id: "perdido", etiqueta: "Perdido", fase: "Cierre" },
];

export const CICLO_VIDA: readonly Opcion[] = [
  { id: "new", etiqueta: "Nuevo" },
  { id: "opportunity", etiqueta: "Oportunidad" },
  { id: "proposal", etiqueta: "Propuesta" },
  { id: "active_client", etiqueta: "Cliente activo" },
  { id: "lost", etiqueta: "Perdido" },
];

export const PRIORIDADES: readonly Opcion[] = [
  { id: "high", etiqueta: "Alta" },
  { id: "medium", etiqueta: "Media" },
  { id: "low", etiqueta: "Baja" },
];

export const MOTIVOS_PERDIDA: readonly Opcion[] = [
  { id: "no_contesta", etiqueta: "No contesta" },
  { id: "precio_alto", etiqueta: "Precio demasiado alto" },
  { id: "contratado_otro", etiqueta: "Contrató con otro despacho" },
  { id: "no_interesado", etiqueta: "No interesado" },
  { id: "fuera_perfil", etiqueta: "Fuera de perfil" },
  { id: "gestiona_interno", etiqueta: "Lo gestiona internamente" },
];
