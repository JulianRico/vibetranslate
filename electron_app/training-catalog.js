/**
 * training-catalog.js - Catálogo de sectores, temas de entrevista y reunión internacional,
 * niveles de exigencia y operaciones puras sobre el libreto generado por IA.
 */

const MODES = {
  interview: {
    id: 'interview',
    label: 'Entrevista',
    shortLabel: 'Entrevista de trabajo',
    enName: 'job interview',
    description: 'Simula una entrevista en inglés con un hiring manager o panel internacional.'
  },
  meeting: {
    id: 'meeting',
    label: 'Reunión internacional',
    shortLabel: 'Reunión de equipo',
    enName: 'international team meeting',
    description: 'Simula una reunión laboral real con clientes, líderes o colegas en inglés.'
  }
};

const LEVELS = [
  { id: 'collaborative', label: 'Colaborativo (equipo cercano)', enDesc: 'supportive, collaborative international teammate or manager' },
  { id: 'senior', label: 'Senior / Exigente (estándar internacional)', enDesc: 'direct, senior international hiring manager or lead who probes for concrete examples, metrics and trade-offs' },
  { id: 'executive', label: 'Ejecutivo / Cliente directo', enDesc: 'concise, high-bar executive or international client who values bottom-line-up-front (BLUF) clarity, business impact and pushback with data' }
];

const SECTORS = [
  {
    id: 'm365',
    label: 'Microsoft 365, SharePoint y Azure',
    enLabel: 'Microsoft 365, SharePoint Online & Azure',
    defaultRole: 'Senior SharePoint Online Developer',
    topics: {
      interview: [
        'Arquitectura SPFx, Microsoft Graph y rendimiento en SharePoint Online',
        'Migraciones a gran escala, gobernanza y permisos en Microsoft 365',
        'Power Platform, automatización empresarial y seguridad en Azure',
        'Liderazgo técnico y defensa de proyectos pasados (método STAR)'
      ],
      meeting: [
        'Daily Stand-up con bloqueos de permisos y dependencias en Azure',
        'Sprint Demo de una intranet SPFx ante stakeholders internacionales',
        'War Room: incidente de throttling en Microsoft Graph en producción',
        'Negociación de alcance y plazos con cliente corporativo en EE. UU.'
      ]
    }
  },
  {
    id: 'software',
    label: 'Tecnología y Desarrollo de Software',
    enLabel: 'Software Engineering & Cloud Technology',
    defaultRole: 'Senior Full-Stack Software Engineer',
    topics: {
      interview: [
        'Diseño de sistemas distribuidos, APIs y escalabilidad',
        'Resolución de incidentes complejos y deuda técnica (STAR)',
        'Arquitectura frontend/backend, testing y CI/CD',
        'Colaboración en equipos remotos, code reviews y mentoría'
      ],
      meeting: [
        'Daily Stand-up: reportar avances, riesgos y pedir apoyo',
        'Revisión de arquitectura (RFC) y defensa de trade-offs técnicos',
        'Post-mortem sin culpas tras una caída en producción',
        'Sprint Planning: estimar trabajo y negociar prioridades con Producto'
      ]
    }
  },
  {
    id: 'data_ai',
    label: 'Datos, Analítica e Inteligencia Artificial',
    enLabel: 'Data Engineering, Analytics & AI',
    defaultRole: 'Senior Data & AI Engineer',
    topics: {
      interview: [
        'Pipelines de datos, calidad y arquitectura en la nube',
        'Implementación de modelos de IA / LLMs en producción y evaluación',
        'Traducción de métricas complejas a decisiones de negocio',
        'Gobernanza de datos, privacidad y costos en escala'
      ],
      meeting: [
        'Presentación de resultados de un modelo o dashboard a directivos',
        'Alineación con Producto sobre métricas KPI y calidad de datos',
        'Revisión de costos de inferencia y latencia en producción',
        'Kickoff de proyecto analítico con equipo internacional'
      ]
    }
  },
  {
    id: 'product_ux',
    label: 'Producto, Diseño UX y Agilidad',
    enLabel: 'Product Management, UX Design & Agile',
    defaultRole: 'Senior Product Manager / UX Lead',
    topics: {
      interview: [
        'Priorización de roadmap con recursos limitados y métricas',
        'Descubrimiento de usuarios y validación de hipótesis',
        'Alineación de stakeholders con intereses opuestos',
        'Caso de producto: lanzamiento internacional de una funcionalidad'
      ],
      meeting: [
        'Revisión trimestral de roadmap (QBR) con liderazgo global',
        'Crítica de diseño (Design Critique) y recepción de feedback directo',
        'Negociar recortes de alcance antes de un lanzamiento clave',
        'Descubrimiento y entrevistas con clientes de Norteamérica/Europa'
      ]
    }
  },
  {
    id: 'finance',
    label: 'Finanzas, Banca y Fintech',
    enLabel: 'Finance, Banking & Fintech',
    defaultRole: 'Senior Financial Analyst / Fintech Lead',
    topics: {
      interview: [
        'Análisis financiero, presupuestos y proyecciones de riesgo',
        'Cumplimiento normativo, auditoría y controles internos',
        'Integración de pagos internacionales y prevención de fraude',
        'Presentación de recomendaciones financieras a dirección'
      ],
      meeting: [
        'Revisión mensual de resultados (P&L) y desviaciones presupuestales',
        'Alineación de riesgos y cumplimiento con oficina matriz',
        'Negociación de condiciones con un proveedor o socio global',
        'Actualización ejecutiva de flujo de caja y prioridades del trimestre'
      ]
    }
  },
  {
    id: 'consulting',
    label: 'Consultoría, Ventas B2B y Negocios',
    enLabel: 'Management Consulting & B2B Enterprise Sales',
    defaultRole: 'Enterprise Consultant / Account Executive',
    topics: {
      interview: [
        'Caso de negocio: diagnóstico, propuesta de valor y ROI',
        'Manejo de objeciones de clientes ejecutivos y cierre',
        'Gestión de cuentas clave internacionales y expansión',
        'Liderazgo de proyectos de transformación con múltiples equipos'
      ],
      meeting: [
        'Reunión de descubrimiento (Discovery Call) con prospecto internacional',
        'Presentación de propuesta ejecutiva y defensa del presupuesto',
        'Reunión de seguimiento de cuenta en riesgo (Account Escalation)',
        'Kickoff de consultoría: alcance, hitos y responsables'
      ]
    }
  },
  {
    id: 'marketing',
    label: 'Marketing Digital, Growth y E-commerce',
    enLabel: 'Digital Marketing, Growth & E-commerce',
    defaultRole: 'Growth Marketing Manager',
    topics: {
      interview: [
        'Estrategia de adquisición, embudos de conversión y CAC/LTV',
        'Expansión a mercados internacionales y localización de campañas',
        'Experimentos A/B, atribución y toma de decisiones con datos',
        'Coordinación entre Marketing, Ventas y Producto'
      ],
      meeting: [
        'Revisión semanal de métricas de campaña y optimización de presupuesto',
        'Lanzamiento regional de producto con equipo global de marca',
        'Alineación entre Growth y Ventas sobre calidad de leads',
        'Post-mortem de campaña con bajo rendimiento y plan correctivo'
      ]
    }
  },
  {
    id: 'health',
    label: 'Salud, Farmacéutica y Biotech',
    enLabel: 'Healthcare, Pharma & Biotech',
    defaultRole: 'Clinical Operations / Healthcare Specialist',
    topics: {
      interview: [
        'Calidad, regulación (FDA/EMA/HIPAA) y trazabilidad',
        'Coordinación de estudios o proyectos clínicos multicéntricos',
        'Innovación en salud digital y gestión del cambio',
        'Resolución de hallazgos de auditoría bajo presión'
      ],
      meeting: [
        'Seguimiento semanal con equipo regulatorio internacional',
        'Revisión de desviaciones de calidad y acciones CAPA',
        'Coordinación de cronograma con investigadores en varios husos horarios',
        'Presentación de avances de proyecto a comité directivo'
      ]
    }
  },
  {
    id: 'operations',
    label: 'Operaciones, Logística y Supply Chain',
    enLabel: 'Operations, Logistics & Supply Chain',
    defaultRole: 'Operations & Supply Chain Manager',
    topics: {
      interview: [
        'Optimización de cadena de suministro, inventarios y SLAs',
        'Gestión de crisis logísticas y proveedores internacionales',
        'Mejora continua (Lean/Six Sigma) y reducción de costos',
        'Liderazgo operativo en equipos distribuidos'
      ],
      meeting: [
        'Reunión de crisis por retraso de proveedor internacional',
        'Revisión mensual de KPIs operativos y tiempos de entrega',
        'Negociación de tarifas y niveles de servicio (SLA) con socios',
        'Planificación de demanda para temporada pico con sede global'
      ]
    }
  },
  {
    id: 'custom',
    label: 'Otro sector (escribir…)',
    enLabel: 'Custom Industry',
    defaultRole: 'International Team Specialist',
    topics: {
      interview: [
        'Entrevista general para posición internacional en inglés',
        'Defensa de experiencia y logros clave (método STAR)',
        'Resolución de conflictos y trabajo colaborativo multicultural',
        'Entrevista final con dirección o cliente extranjero'
      ],
      meeting: [
        'Reunión semanal de seguimiento con equipo internacional',
        'Presentación de propuesta y alineación de próximos pasos',
        'Manejo de desacuerdos y negociación de plazos con tacto',
        '1-on-1 con tu manager internacional sobre objetivos y feedback'
      ]
    }
  }
];

function getSectorById(id) {
  return SECTORS.find((s) => s.id === id) || SECTORS[0];
}

function getTopicsFor(mode, sectorId) {
  const m = mode === 'meeting' ? 'meeting' : 'interview';
  const sector = getSectorById(sectorId);
  return (sector.topics && sector.topics[m]) ? sector.topics[m].slice() : [];
}

function getLevelById(id) {
  return LEVELS.find((l) => l.id === id) || LEVELS[1];
}

function resolveSectorLabel(sectorId, customSector = '') {
  if (sectorId === 'custom') {
    const clean = String(customSector || '').trim();
    return clean || 'Negocios internacionales';
  }
  const found = SECTORS.find((s) => s.id === sectorId);
  return found ? found.label : (String(sectorId || '').trim() || SECTORS[0].label);
}

/** Crea un turno nuevo listo para añadir al libreto editable. */
function createEmptyTurn(index, mode = 'interview') {
  const isMeeting = mode === 'meeting';
  return {
    id: `turn-${Date.now()}-${index}`,
    question: {
      en: isMeeting
        ? 'Could you give us a quick update on your part and flag any blockers?'
        : 'Could you walk me through a challenging situation you handled recently?',
      es: isMeeting
        ? '¿Podrías darnos una actualización rápida de tu parte e indicar si hay bloqueos?'
        : '¿Podrías contarme una situación retadora que hayas manejado recientemente?'
    },
    intent: isMeeting
      ? 'Evalúa claridad al resumir el estado actual, riesgos y pasos concretos.'
      : 'Evalúa tu criterio, responsabilidad personal e impacto medible.',
    howToAnswer: isMeeting
      ? 'Usa estructura BLUF: primero la conclusión o estado, luego el riesgo o bloqueo y cierra con una propuesta clara.'
      : 'Usa estructura STAR: contexto breve, tu acción concreta y resultado medible.',
    sampleAnswer: {
      en: isMeeting
        ? 'Quick summary: we are on track for Thursday, but we need sign-off on API permissions today to avoid a two-day slip.'
        : 'In my last project, we faced a major bottleneck. I redesigned the caching layer, which cut latency by 45 percent.',
      es: isMeeting
        ? 'Resumen rápido: vamos en fecha para el jueves, pero necesitamos aprobación de permisos de API hoy para evitar un retraso de dos días.'
        : 'En mi último proyecto tuvimos un cuello de botella importante. Rediseñé la capa de caché y redujimos la latencia en un 45 por ciento.'
    },
    keyPhrases: [
      { en: 'To give you the short version first…', es: 'Para darte primero el resumen…' },
      { en: 'The key trade-off here is…', es: 'El compromiso clave aquí es…' }
    ],
    evalCriteria: [
      'Respuesta clara y estructurada sin rodeos',
      'Vocabulario profesional adecuado al sector',
      'Cierre concreto con resultado o siguiente paso'
    ]
  };
}

/** Actualiza la pregunta (en/es) o guía de un turno del libreto sin mutar el original. */
function updatePlaybookTurn(playbook, index, patch) {
  if (!playbook || !Array.isArray(playbook.turns) || index < 0 || index >= playbook.turns.length) return playbook;
  const turns = playbook.turns.map((turn, i) => {
    if (i !== index) return turn;
    return {
      ...turn,
      ...patch,
      question: patch.question ? { ...turn.question, ...patch.question } : turn.question,
      sampleAnswer: patch.sampleAnswer ? { ...turn.sampleAnswer, ...patch.sampleAnswer } : turn.sampleAnswer
    };
  });
  return { ...playbook, turns };
}

function addPlaybookTurn(playbook, turn) {
  if (!playbook) return playbook;
  const turns = Array.isArray(playbook.turns) ? [...playbook.turns, turn] : [turn];
  return { ...playbook, turns };
}

function removePlaybookTurn(playbook, index) {
  if (!playbook || !Array.isArray(playbook.turns) || playbook.turns.length <= 1) return playbook;
  const turns = playbook.turns.filter((_, i) => i !== index);
  return { ...playbook, turns };
}

/**
 * Convierte el glosario del libreto en líneas «término = término» listas para fusionar
 * en el vocabulario propio del reconocedor sin duplicar entradas existentes.
 */
function mergeVocabularyText(existingText, vocabulary = []) {
  const existingLines = String(existingText || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const known = new Set(existingLines.map((l) => l.split('=')[0].trim().toLowerCase()));
  const added = [];
  for (const item of vocabulary || []) {
    const term = String(item && item.term ? item.term : '').trim();
    if (!term || term.length < 2) continue;
    const key = term.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);
    added.push(`${key} = ${term}`);
  }
  return {
    text: [...existingLines, ...added].join('\n'),
    addedCount: added.length
  };
}

/** Mantiene los últimos N libretos/escenarios guardados para reutilizarlos rápido. */
function upsertRecentPlaybook(list, entry, max = 6) {
  const clean = Array.isArray(list) ? list.filter((x) => x && x.id && x.setup && x.playbook) : [];
  const filtered = clean.filter((x) => x.id !== entry.id);
  return [entry, ...filtered].slice(0, max);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MODES,
    LEVELS,
    SECTORS,
    getSectorById,
    getTopicsFor,
    getLevelById,
    resolveSectorLabel,
    createEmptyTurn,
    updatePlaybookTurn,
    addPlaybookTurn,
    removePlaybookTurn,
    mergeVocabularyText,
    upsertRecentPlaybook
  };
}
