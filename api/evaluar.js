/* ============================================================================
 * DARABIA ENGINE V5 — VERCEL SERVERLESS FUNCTION (PROXY ANTHROPIC)
 * api/evaluar.js · v2.0 · Bifurcación alumno / docente
 * Autor: Honás Darabia (Jonás Agudo Osuna) · IES Virgen del Pilar, Zaragoza
 *
 * RESPONSABILIDADES:
 *   1. Recibe payload del cliente y bifurca según ?destinatario=alumno|docente.
 *   2. Construye el system prompt dinámicamente desde la rúbrica del JSON.
 *   3. Llama a Anthropic una vez por petición (zero estado en backend).
 *   4. Devuelve únicamente el bloque que corresponde al destinatario.
 *
 * DECISIÓN ARQUITECTÓNICA (cerrada con el profesor):
 *   El alumno solo recibe el bloque alumno. NO hay token, NO hay cifrado en
 *   cliente, NO hay persistencia compartida. Si el profesor necesita corregir,
 *   abre corrector.html, pega el texto del dictamen del alumno e introduce
 *   nombre/grupo. El backend re-evalúa con Anthropic y devuelve ambos bloques.
 *
 *   Ventaja: arquitectura trivial, mantenible, defendible.
 *   Coste: una llamada extra a Anthropic por cada corrección manual del
 *   profesor (~75 llamadas/año en condiciones de aula reales). Despreciable.
 *
 * SEGURIDAD:
 *   · El bloque docente NUNCA viaja al cliente del alumno.
 *   · El endpoint docente requiere Bearer token (PROFESOR_TOKEN).
 *   · El alumno NO puede acceder al bloque docente bajo ninguna circunstancia,
 *     ni siquiera con DevTools, porque el backend nunca se lo envía.
 *
 * VARIABLES DE ENTORNO REQUERIDAS:
 *   · ANTHROPIC_API_KEY    — clave de la API de Anthropic
 *   · PROFESOR_TOKEN       — string secreto, mínimo 16 caracteres
 *   · DARABIA_MOCK         — 'true' para usar mock sin gastar tokens (opcional)
 *
 * RUTAS:
 *   POST /api/evaluar?destinatario=alumno
 *     Body: { caso_id, version_motor, alumno, dictamen, llaves_desbloqueadas, ... }
 *     Auth: ninguna
 *     Returns: { nota_global, vector_ejes, perfil_tecnico, que_has_hecho_bien,
 *                que_puedes_mejorar, errores_clave_pedagogicos, error_critico,
 *                evaluacion_criterios, _meta }
 *
 *   POST /api/evaluar?destinatario=docente
 *     Body: { caso_id, alumno: { nombre, grupo }, dictamen: { texto_completo },
 *             llaves_desbloqueadas? }
 *     Auth: Authorization: Bearer <PROFESOR_TOKEN>
 *     Returns: { nota_global, ..., bloque_alumno: {...}, bloque_docente: {...},
 *                contexto: {...}, _meta }
 * ============================================================================ */

'use strict';

const crypto = require('crypto');

// ============================================================================
// SECCIÓN A — JSON DE CASOS DISPONIBLES
// ============================================================================

const CASOS = {
  psicosocial_gestoria_v1: require('./casos/psicosocial_gestoria.json'),
  // Casos futuros: psicosocial_caso06_v1, etc.
};

// ============================================================================
// SECCIÓN B — CONFIGURACIÓN GLOBAL
// ============================================================================

const CONFIG = {
  version_api: '2.0.1',
  version_motor_soportada: '5.0.0',
  modelo_anthropic: 'claude-sonnet-4-20250514',
  max_tokens_respuesta: 3000,
  cors_origins_permitidos: [
    'https://darabia.vercel.app',
    'https://aeducar.es',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:5500'
  ],
  longitud_minima_dictamen: 200,
};

// ============================================================================
// SECCIÓN C — HANDLER PRINCIPAL
// ============================================================================

module.exports = async function handler(req, res) {
  _setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return _crearResError(res, 405, 'METHOD_NOT_ALLOWED', 'Solo se admite POST.');
  }

  try {
    const destinatario = (req.query?.destinatario || 'alumno').toLowerCase();

    if (destinatario === 'alumno') return await _handleAlumno(req, res);
    if (destinatario === 'docente') return await _handleDocente(req, res);

    return _crearResError(res, 400, 'DESTINATARIO_INVALIDO',
      `destinatario "${destinatario}" no reconocido. Valores válidos: alumno | docente.`);

  } catch (err) {
    return _manejarError(res, err);
  }
};

// ============================================================================
// SECCIÓN D — HANDLER ALUMNO (público, sin auth)
// ============================================================================
/**
 * Flujo:
 *   1. Validar payload del motor cliente.
 *   2. Resolver caso desde caso_id.
 *   3. Llamar a Anthropic (o mock) con system prompt completo.
 *   4. Bifurcar respuesta y devolver SOLO el bloque alumno.
 */
async function _handleAlumno(req, res) {
  const payload = _validarPayload(req.body);
  const caso = _resolverCaso(payload.caso_id);

  const esMock = process.env.DARABIA_MOCK === 'true';
  const evaluacionCompleta = esMock
    ? _generarMock(caso, payload)
    : await _llamarAnthropic(caso, payload);

  _validarRespuestaIA(evaluacionCompleta, caso);

  const { bloqueAlumno } = _bifurcarRespuesta(evaluacionCompleta);

  _logAuditoria(payload, evaluacionCompleta, esMock, 'alumno');

  return res.status(200).json({
    ...bloqueAlumno,
    _meta: {
      version_api: CONFIG.version_api,
      mock: esMock || undefined,
    }
  });
}

// ============================================================================
// SECCIÓN E — HANDLER DOCENTE (requiere Bearer PROFESOR_TOKEN)
// ============================================================================
/**
 * Flujo:
 *   1. Validar Bearer token del profesor (variable de entorno).
 *   2. Validar payload (mismo schema que alumno; el dictamen viene del alumno
 *      copiado/pegado por el profesor en corrector.html).
 *   3. Llamar a Anthropic con el mismo system prompt que en alumno.
 *   4. Devolver respuesta completa + ambos bloques separados explícitamente.
 *
 * El profesor obtiene una segunda evaluación del mismo dictamen. La nota
 * automática no es necesariamente idéntica a la que vio el alumno (el modelo
 * tiene cierta variabilidad), pero el bloque docente no era accesible antes,
 * así que este flujo es la fuente de verdad para la corrección manual del 40%.
 */
async function _handleDocente(req, res) {
  // 1. Auth
  const tokenProfesor = process.env.PROFESOR_TOKEN;
  if (!tokenProfesor || tokenProfesor.length < 16) {
    return _crearResError(res, 500, 'CONFIG_ERROR',
      'PROFESOR_TOKEN no configurado o demasiado corto en variables de entorno (mínimo 16 caracteres).');
  }

  const auth = req.headers.authorization || '';
  const presentado = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!presentado || !_compararTokensConstante(presentado, tokenProfesor)) {
    // Mensaje deliberadamente genérico: no distinguimos "ausente" de "inválido"
    // para no facilitar ataques de enumeración.
    return _crearResError(res, 401, 'NO_AUTORIZADO',
      'Acceso denegado al modo docente.');
  }

  // 2. Validar payload (formato similar al del alumno, sin marca de validado)
  const payload = _validarPayloadDocente(req.body);
  const caso = _resolverCaso(payload.caso_id);

  // 3. Re-evaluar
  const esMock = process.env.DARABIA_MOCK === 'true';
  const evaluacionCompleta = esMock
    ? _generarMock(caso, payload)
    : await _llamarAnthropic(caso, payload);

  _validarRespuestaIA(evaluacionCompleta, caso);

  const { bloqueAlumno, bloqueDocente } = _bifurcarRespuesta(evaluacionCompleta);

  _logAuditoria(payload, evaluacionCompleta, esMock, 'docente');

  // 4. Devolver TODO al profesor: nota global, ambos bloques, datos crudos
  return res.status(200).json({
    nota_global: evaluacionCompleta.nota_global,
    vector_ejes: evaluacionCompleta.vector_ejes,
    detalle_criterios: evaluacionCompleta.detalle_criterios,
    bloque_alumno: bloqueAlumno,
    bloque_docente: bloqueDocente,
    contexto: {
      caso_titulo: caso.caso.titulo,
      caso_id: payload.caso_id,
      alumno: { nombre: payload.alumno.nombre, grupo: payload.alumno.grupo || null },
      timestamp_evaluacion: new Date().toISOString(),
    },
    _meta: {
      version_api: CONFIG.version_api,
      mock: esMock || undefined,
      origen: 'reevaluacion_docente',
    },
  });
}

// ============================================================================
// SECCIÓN F — VALIDACIÓN DE PAYLOADS
// ============================================================================

function _validarPayload(body) {
  if (!body || typeof body !== 'object') {
    throw _crearError('PAYLOAD_INVALIDO', 400,
      'El cuerpo de la petición no es un objeto JSON válido.');
  }

  const requeridos = ['caso_id', 'version_motor', 'alumno', 'dictamen'];
  for (const campo of requeridos) {
    if (!body[campo]) {
      throw _crearError('PAYLOAD_INVALIDO', 400, `Campo requerido ausente: "${campo}".`);
    }
  }

  if (!body.alumno?.validado || !body.alumno?.nombre) {
    throw _crearError('ALUMNO_NO_VALIDADO', 400,
      'El alumno no está validado en el payload.');
  }

  if (!body.dictamen?.texto_completo
      || body.dictamen.texto_completo.trim().length < CONFIG.longitud_minima_dictamen) {
    throw _crearError('DICTAMEN_INSUFICIENTE', 400,
      `El dictamen está vacío o es demasiado breve (mínimo ${CONFIG.longitud_minima_dictamen} caracteres).`);
  }

  if (body.version_motor !== CONFIG.version_motor_soportada) {
    console.warn(`[EVALUAR] Versión de motor inesperada: ${body.version_motor} (esperada: ${CONFIG.version_motor_soportada})`);
  }

  return body;
}

/**
 * Validación específica del payload docente. Más permisiva en algunos campos
 * (no exige alumno.validado, no exige version_motor) porque el profesor está
 * pegando el dictamen manualmente desde corrector.html, no enviándolo desde
 * el motor. Pero exige caso_id, alumno.nombre y dictamen.texto_completo.
 */
function _validarPayloadDocente(body) {
  if (!body || typeof body !== 'object') {
    throw _crearError('PAYLOAD_INVALIDO', 400,
      'El cuerpo de la petición no es un objeto JSON válido.');
  }

  if (!body.caso_id) {
    throw _crearError('PAYLOAD_INVALIDO', 400, 'Falta caso_id.');
  }
  if (!body.alumno?.nombre || typeof body.alumno.nombre !== 'string') {
    throw _crearError('PAYLOAD_INVALIDO', 400, 'Falta alumno.nombre (string).');
  }
  if (!body.dictamen?.texto_completo
      || body.dictamen.texto_completo.trim().length < CONFIG.longitud_minima_dictamen) {
    throw _crearError('DICTAMEN_INSUFICIENTE', 400,
      `El dictamen está vacío o es demasiado breve (mínimo ${CONFIG.longitud_minima_dictamen} caracteres).`);
  }

  // Normalizamos a la misma forma que el payload del alumno para que el resto
  // del pipeline (system prompt, mock) funcione sin ramas adicionales.
  return {
    caso_id: body.caso_id,
    version_motor: body.version_motor || CONFIG.version_motor_soportada,
    modo_juego: body.modo_juego || null,
    alumno: {
      nombre: body.alumno.nombre.trim(),
      grupo: (body.alumno.grupo || '').trim(),
      validado: true, // sintético: el profesor está autenticado, el alumno se asume real
    },
    dictamen: {
      texto_completo: body.dictamen.texto_completo,
      secciones: body.dictamen.secciones || {},
    },
    llaves_desbloqueadas: Array.isArray(body.llaves_desbloqueadas)
      ? body.llaves_desbloqueadas
      : [],
    timestamp_envio: new Date().toISOString(),
  };
}

// ============================================================================
// SECCIÓN G — RESOLUCIÓN DE CASO
// ============================================================================

function _resolverCaso(caso_id) {
  const caso = CASOS[caso_id];
  if (!caso) {
    throw _crearError('CASO_NO_ENCONTRADO', 404,
      `caso_id "${caso_id}" no está registrado. Casos disponibles: ${Object.keys(CASOS).join(', ')}`);
  }
  return caso;
}

// ============================================================================
// SECCIÓN H — CONSTRUCCIÓN DEL SYSTEM PROMPT
// ============================================================================
/**
 * El system prompt se genera 100% desde el JSON del caso. Cero hardcoding.
 * El modelo recibe instrucciones para devolver dos bloques explícitos:
 * pedagógico (alumno) y docente (profesor). El backend separa después.
 */
function _construirSystemPrompt(caso, payload) {
  const { rubrica_evaluacion, ejes_evaluacion, mapeo_ejes_criterios, knockout_criteria } = caso.aciertos_criticos;

  const identidad = `Eres Honás Darabia, técnico PRL colegiado nº 0847, perito evaluador del simulador de psicosociología aplicada Darabia Engine V5.
Tu función es evaluar el dictamen de un alumno de CFGS Prevención de Riesgos Profesionales y devolver una evaluación estructurada en JSON con DOS bloques separados: uno pedagógico para el alumno y uno técnico para el profesor.
Tono: directo, técnico, preciso. Sin condescendencia. Sin relleno. El feedback al alumno enseña, no humilla. Los comentarios al profesor son útiles o no son.`;

  const ctxCaso = `
CASO: ${caso.caso.titulo}
SECTOR: ${caso.caso.sector}
MODELOS TEÓRICOS DEL CASO: ${caso.caso.modelos_teoricos.join(', ')}
INSTRUMENTO: ${caso.caso.instrumento}
EMPRESA: ${caso.contexto.empresa}
PLANTILLA: ${caso.contexto.plantilla} personas
DATOS OBJETIVOS: Absentismo ${caso.contexto.datos_objetivos.absentismo} (sector: ${caso.contexto.datos_objetivos.referencia_sector}), ${caso.contexto.datos_objetivos.bajas_psicologicas_12m} bajas psicológicas en 12 meses (${caso.contexto.datos_objetivos.dias_baja_total} días), horas extra media marzo: ${caso.contexto.datos_objetivos.horas_extra_media_marzo}, última evaluación psicosocial: ${caso.contexto.datos_objetivos.ultima_evaluacion_psicosocial}.`;

  const rubricaTexto = rubrica_evaluacion.criterios.map(c =>
    `  - ${c.nombre} (id: "${c.id}", peso: ${c.peso}%): ${c.descripcion}`
  ).join('\n');

  const rubrica = `
RÚBRICA DE EVALUACIÓN (total: ${rubrica_evaluacion.total_sumando}%):
${rubricaTexto}`;

  const mapeoTexto = Object.entries(mapeo_ejes_criterios).map(([eje, criterios]) =>
    `  - ${eje}: evalúa los criterios [${criterios.join(', ')}]`
  ).join('\n');

  const ejesTexto = `
EJES DE EVALUACIÓN Y SU MAPEO A CRITERIOS:
${mapeoTexto}`;

  const knockoutsTexto = Object.entries(knockout_criteria).map(([id, ko]) =>
    `  - KNOCKOUT "${id}": ${ko.descripcion}
    Penalización si se ignora: ${ko.penalizacion_si_ignorada} puntos sobre nota_global.
    Penalización si se diagnostica sin protocolo: ${ko.penalizacion_diagnostico_sin_protocolo} puntos sobre nota_global.
    Respuesta mínima exigida: "${ko.respuesta_minima}".`
  ).join('\n');

  const knockouts = `
CRITERIOS KNOCKOUT TRANSVERSALES (no suman, solo restan si se fallan):
${knockoutsTexto}`;

  const llavesTexto = payload.llaves_desbloqueadas?.length > 0
    ? payload.llaves_desbloqueadas.join(', ')
    : 'Ninguna llave desbloqueada.';

  const llaves = `
EVIDENCIAS DESBLOQUEADAS POR EL ALUMNO DURANTE LAS ENTREVISTAS:
  ${llavesTexto}
(Usa esto para contextualizar el dictamen — el alumno tuvo acceso a estas evidencias.)`;

  const instruccionesSalida = `
INSTRUCCIONES DE EVALUACIÓN:
1. Lee el dictamen completo del alumno.
2. Evalúa cada criterio de la rúbrica con rigor técnico.
3. Aplica penalizaciones knockout si corresponde (restan de nota_global).
4. Calcula nota_global como suma ponderada de criterios (0-100), con knockouts aplicados. Nunca por debajo de 0.
5. Para cada eje de evaluación, calcula la puntuación obtenida sobre su máximo (suma de pesos de los criterios que componen ese eje).

DOS BLOQUES DE SALIDA — NO SE MEZCLAN:

A) BLOQUE PEDAGÓGICO (lo verá el alumno):
   · perfil_tecnico: 1-2 frases que describan el perfil del alumno como técnico (qué tipo de profesional sería).
   · que_has_hecho_bien: 2-4 puntos concretos sobre fortalezas reales de su dictamen, lenguaje claro y constructivo.
   · que_puedes_mejorar: 2-4 puntos formulados como áreas de mejora, no como reproches.
   · errores_clave_pedagogicos: 0-3 errores técnicos importantes explicados en términos formativos (qué falló y por qué importa).
   · error_critico: si hay UN error que impacta especialmente en la nota, explícalo aquí en una frase clara y constructiva. null si no aplica.
   PROHIBIDO en este bloque: referencias a "penalización", "rúbrica", "knockout", "puntos restados", "calificación 40% manual" o cualquier término de evaluación interna. Solo aprendizaje.

B) BLOQUE DOCENTE (lo verá únicamente el profesor):
   · nota_asesoramiento_docente: análisis denso de hasta 350 palabras. Puntos fuertes y débiles del dictamen, knockouts aplicados con motivo, qué observar en la corrección manual del 40%, comparación con la resolución modelo si procede.
   · sugerencia_calificacion_40_manual: número 0-40 que sugieres como nota razonable para la corrección manual del profesor. Orientativo, no vinculante.
   · alertas_correccion: 0-5 alertas técnicas que el profesor debería verificar a mano antes de cerrar la nota.

FORMATO DE SALIDA — RESPONDE ÚNICAMENTE CON ESTE JSON. SIN TEXTO ANTES NI DESPUÉS. SIN BACKTICKS. SIN MARKDOWN:
{
  "nota_global": <número 0-100>,
  "vector_ejes": [
    ${ejes_evaluacion.map(eje => {
      const criteriosDelEje = mapeo_ejes_criterios[eje] || [];
      const maxEje = rubrica_evaluacion.criterios
        .filter(c => criteriosDelEje.includes(c.id))
        .reduce((s, c) => s + c.peso, 0);
      return `{ "eje": "${eje}", "puntuacion": <número 0-${maxEje}>, "max": ${maxEje} }`;
    }).join(',\n    ')}
  ],
  "detalle_criterios": {
    ${rubrica_evaluacion.criterios.map(c =>
      `"${c.id}": { "puntuacion": <número 0-${c.peso}>, "max": ${c.peso}, "observacion": "<máx 80 palabras>" }`
    ).join(',\n    ')}
  },
  "knockouts_aplicados": [
    { "id": "<knockout_id>", "penalizacion": <número>, "motivo": "<texto breve>" }
  ],
  "perfil_tecnico": "<1-2 frases>",
  "que_has_hecho_bien": ["<punto 1>", "<punto 2>"],
  "que_puedes_mejorar": ["<punto 1>", "<punto 2>"],
  "errores_clave_pedagogicos": ["<error 1 explicado pedagógicamente>"],
  "error_critico": "<frase o null>",
  "nota_asesoramiento_docente": "<texto para el profesor, máx 350 palabras>",
  "sugerencia_calificacion_40_manual": <número 0-40>,
  "alertas_correccion": ["<alerta 1>", "<alerta 2>"]
}`;

  const jsonCasoCompleto = `
================================================================================
REFERENCIA TÉCNICA — JSON COMPLETO DEL CASO (fuente de verdad para la evaluación)
================================================================================
${JSON.stringify(caso, null, 2)}
================================================================================`;

  return [identidad, ctxCaso, rubrica, ejesTexto, knockouts, llaves, instruccionesSalida, jsonCasoCompleto].join('\n');
}

// ============================================================================
// SECCIÓN I — LLAMADA A ANTHROPIC
// ============================================================================

async function _llamarAnthropic(caso, payload) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw _crearError('CONFIG_ERROR', 500,
      'ANTHROPIC_API_KEY no está configurada en las variables de entorno de Vercel.');
  }

  const systemPrompt = _construirSystemPrompt(caso, payload);

  const mensajeUsuario = `DICTAMEN DEL ALUMNO:

${payload.dictamen.texto_completo}

---

ALUMNO: ${payload.alumno.nombre}${payload.alumno.grupo ? ' · Grupo: ' + payload.alumno.grupo : ''}
CASO: ${payload.caso_id}

Evalúa este dictamen siguiendo la rúbrica y devuelve únicamente el JSON estructurado, con los dos bloques (pedagógico y docente) tal como se indica.`;

  let resp;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CONFIG.modelo_anthropic,
        max_tokens: CONFIG.max_tokens_respuesta,
        // temperature: 0 para que la misma entrada produzca la misma salida.
        // Esto garantiza que la nota que ve el alumno y la nota que ve el
        // profesor en la re-evaluación coincidan. En contexto educativo, la
        // reproducibilidad es más valiosa que la riqueza estilística.
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: mensajeUsuario }],
      }),
    });
  } catch (e) {
    throw _crearError('UPSTREAM_ERROR', 502,
      `No se pudo contactar con Anthropic: ${e.message}`);
  }

  if (resp.status === 429) {
    throw _crearError('LIMITE_CUOTA', 429,
      'La API de Anthropic ha rechazado la petición por límite de cuota.');
  }
  if (resp.status === 402) {
    throw _crearError('SIN_SALDO', 402,
      'La API de Anthropic indica que no hay saldo disponible.');
  }
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw _crearError('UPSTREAM_ERROR', 502,
      `Anthropic devolvió ${resp.status}: ${txt.slice(0, 200)}`);
  }

  const data = await resp.json();
  const contenido = data?.content?.[0]?.text || '';
  if (!contenido) {
    throw _crearError('RESPUESTA_VACIA', 502, 'Anthropic devolvió contenido vacío.');
  }

  // Limpieza defensiva por si el modelo envuelve en ```json``` aunque le digamos que no
  const limpio = contenido.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(limpio);
  } catch (e) {
    throw _crearError('RESPUESTA_NO_JSON', 502,
      `La respuesta de Anthropic no es JSON válido. Inicio: "${limpio.slice(0, 120)}"`);
  }

  return parsed;
}

// ============================================================================
// SECCIÓN J — BIFURCACIÓN ALUMNO/DOCENTE
// ============================================================================
/**
 * Esta función es la frontera pedagógica del sistema. Recibe el JSON crudo del
 * modelo y produce dos objetos sin solapamiento de campos sensibles:
 *
 *   bloqueAlumno  → contenido pedagógico, lo que el alumno verá.
 *   bloqueDocente → contenido de evaluación, sólo el profesor.
 *
 * El campo evaluacion_criterios (mapa criterio_id → 0-10) se incluye en el
 * bloque alumno porque la UI de resultado dibuja barras de competencias.
 * Eso enseña sin desvelar nada sensible.
 */
function _bifurcarRespuesta(eval_completa) {
  const bloqueAlumno = {
    nota_global: eval_completa.nota_global,
    vector_ejes: eval_completa.vector_ejes,
    perfil_tecnico: eval_completa.perfil_tecnico,
    que_has_hecho_bien: eval_completa.que_has_hecho_bien || [],
    que_puedes_mejorar: eval_completa.que_puedes_mejorar || [],
    errores_clave_pedagogicos: eval_completa.errores_clave_pedagogicos || [],
    errores_clave: eval_completa.errores_clave_pedagogicos || [], // alias compat UI
    error_critico: eval_completa.error_critico || null,
    evaluacion_criterios: _aplanarCriterios(eval_completa.detalle_criterios),
    detalle_criterios: eval_completa.detalle_criterios || {},
  };

  const bloqueDocente = {
    nota_asesoramiento_docente: eval_completa.nota_asesoramiento_docente,
    sugerencia_calificacion_40_manual: eval_completa.sugerencia_calificacion_40_manual ?? null,
    alertas_correccion: eval_completa.alertas_correccion || [],
    knockouts_aplicados: eval_completa.knockouts_aplicados || [],
  };

  return { bloqueAlumno, bloqueDocente };
}

/**
 * Convierte detalle_criterios (puntuación según peso del criterio) a una escala
 * 0-10 que la UI de resultado puede dibujar como barras directamente.
 */
function _aplanarCriterios(detalle) {
  if (!detalle || typeof detalle !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(detalle)) {
    if (typeof v === 'number') {
      out[k] = v;
    } else if (v && typeof v === 'object' && typeof v.puntuacion === 'number') {
      const max = typeof v.max === 'number' && v.max > 0 ? v.max : 10;
      out[k] = +(v.puntuacion / max * 10).toFixed(1);
    }
  }
  return out;
}

// ============================================================================
// SECCIÓN K — MOCK (sin API)
// ============================================================================
/**
 * Genera una respuesta determinista para validar el circuito sin gastar tokens.
 * Activado con DARABIA_MOCK=true. Usa la rúbrica del caso para construir
 * detalles coherentes con la estructura real esperada.
 */
function _generarMock(caso, payload) {
  const { rubrica_evaluacion, ejes_evaluacion, mapeo_ejes_criterios } = caso.aciertos_criticos;

  const detallesCriterios = {};
  let notaBase = 0;
  for (const criterio of rubrica_evaluacion.criterios) {
    const pct = criterio.id === 'triangulacion' ? 0.80 :
                criterio.id === 'modelos_teoricos' ? 0.65 :
                criterio.id === 'hipotesis' ? 0.75 :
                criterio.id === 'plan_accion' ? 0.60 :
                criterio.id === 'argumentacion' ? 0.70 : 0.70;

    const puntuacion = Math.round(criterio.peso * pct);
    detallesCriterios[criterio.id] = {
      puntuacion,
      max: criterio.peso,
      observacion: `[MOCK] Nivel ${Math.round(pct * 100)}%. Criterio "${criterio.nombre}" evaluado en modo simulación.`,
    };
    notaBase += puntuacion;
  }

  const knockoutsAplicados = [{
    id: 'senyal_sonia',
    penalizacion: 15,
    motivo: '[MOCK] El alumno no ha abierto protocolo de investigación para la situación de Sonia Peralta.',
  }];
  const notaGlobal = Math.max(0, notaBase - 15);

  const vectorEjes = ejes_evaluacion.map(eje => {
    const criteriosDelEje = mapeo_ejes_criterios[eje] || [];
    const maxEje = rubrica_evaluacion.criterios
      .filter(c => criteriosDelEje.includes(c.id))
      .reduce((s, c) => s + c.peso, 0);
    const puntuacionEje = criteriosDelEje.reduce((s, cId) => {
      return s + (detallesCriterios[cId]?.puntuacion || 0);
    }, 0);
    return { eje, puntuacion: puntuacionEje, max: maxEje };
  });

  return {
    nota_global: notaGlobal,
    vector_ejes: vectorEjes,
    detalle_criterios: detallesCriterios,
    knockouts_aplicados: knockoutsAplicados,

    // Bloque pedagógico
    perfil_tecnico: '[MOCK] Perfil de técnico en formación con buena base de triangulación pero infrautilización de modelos teóricos. Falta criterio jerárquico en el plan de acción.',
    que_has_hecho_bien: [
      'Has cruzado correctamente al menos 3 fuentes en los principales factores de riesgo.',
      'La hipótesis está formulada como problema organizacional, no individual.',
      'Identificas correctamente las dimensiones Karasek de demanda y control en Ana.',
    ],
    que_puedes_mejorar: [
      'Profundiza en el modelo Siegrist: Ana es el caso canónico de Esfuerzo-Recompensa y no lo desarrollas.',
      'En el plan de acción, cada medida debe tener KPI + plazo + responsable. Faltan responsables en al menos 2 medidas.',
      'Articula mejor la fundamentación legal: cita el artículo concreto de la LPRL al apoyar cada medida.',
    ],
    errores_clave_pedagogicos: [
      'Una medida sin responsable asignado no es una medida operativa: es una intención.',
      'Karasek y Siegrist son complementarios. Aplicar solo uno deja ciegos sobre la dimensión recompensa.',
    ],
    error_critico: 'Has tratado la situación de Sonia Peralta como conflicto interpersonal ordinario. La normativa exige abrir protocolo de investigación ante indicios de conducta hostil — no es opcional.',

    // Bloque docente
    nota_asesoramiento_docente:
      `[MODO MOCK — Respuesta simulada]\n\n` +
      `Alumno: ${payload.alumno.nombre} | Grupo: ${payload.alumno.grupo || 'N/A'}\n` +
      `Nota automática simulada: ${notaGlobal}/100 (base ${notaBase} − 15 knockout Sonia)\n\n` +
      `PUNTOS FUERTES: Triangulación aceptable con 2-3 fuentes por factor. ` +
      `Karasek aplicado con dimensiones demanda/control. Hipótesis organizacional, no individual.\n\n` +
      `PUNTOS DÉBILES: Siegrist infrautilizado — Ana es el caso canónico de ERI y el alumno no lo desarrolla. ` +
      `Plan de acción con indicadores incompletos (falta responsable en 2 medidas). ` +
      `CRÍTICO: Sonia Peralta no recibe protocolo de investigación — knockout activado (−15 pts).\n\n` +
      `PARA LA CORRECCIÓN MANUAL (40%): Revisa si el alumno distingue entre hipótesis organizacional e individual. ` +
      `El plan de acción necesita revisión manual del componente Rigor Operativo.`,
    sugerencia_calificacion_40_manual: 24,
    alertas_correccion: [
      'Verificar manualmente si las medidas terciarias se proponen como única respuesta (penaliza −5).',
      'Comprobar que la hipótesis no derive en culpabilización individual.',
    ],

    _mock: true,
  };
}

// ============================================================================
// SECCIÓN L — VALIDACIÓN DE LA RESPUESTA IA
// ============================================================================

function _validarRespuestaIA(data, caso) {
  // Compat: aceptar puntuacion_total como alias de nota_global
  if (typeof data?.puntuacion_total === 'number' && typeof data?.nota_global !== 'number') {
    data.nota_global = data.puntuacion_total;
  }
  if (typeof data?.nota_global !== 'number' || data.nota_global < 0 || data.nota_global > 100) {
    throw _crearError('RESPUESTA_IA_INVALIDA', 502,
      'nota_global ausente o fuera del rango 0-100.');
  }

  if (!Array.isArray(data.vector_ejes)) {
    throw _crearError('RESPUESTA_IA_INVALIDA', 502, 'vector_ejes no es un array.');
  }

  const ejesEsperados = caso.aciertos_criticos.ejes_evaluacion;
  const ejesRecibidos = data.vector_ejes.map(e => e.eje);
  for (const eje of ejesEsperados) {
    if (!ejesRecibidos.includes(eje)) {
      throw _crearError('RESPUESTA_IA_INVALIDA', 502,
        `Falta el eje "${eje}" en vector_ejes.`);
    }
  }

  if (typeof data.perfil_tecnico !== 'string' || data.perfil_tecnico.trim().length < 5) {
    throw _crearError('RESPUESTA_IA_INVALIDA', 502,
      'perfil_tecnico ausente o demasiado corto.');
  }
  if (!Array.isArray(data.que_has_hecho_bien) || !Array.isArray(data.que_puedes_mejorar)) {
    throw _crearError('RESPUESTA_IA_INVALIDA', 502,
      'que_has_hecho_bien / que_puedes_mejorar deben ser arrays.');
  }

  // Bloque docente: nota_asesoramiento_docente debe existir como string,
  // pero se acepta vacío. Esto evita romper el flujo del alumno cuando el
  // modelo, por la razón que sea, no rellena este campo. El profesor verá
  // el string vacío en el corrector y sabrá que debe corregir manualmente
  // el 40% sin orientación automática. En la arquitectura actual el campo
  // se descarta antes de devolver la respuesta al alumno (handler alumno
  // sólo retorna bloque alumno) y se genera de nuevo cuando el profesor
  // re-evalúa con el corrector docente.
  if (data.nota_asesoramiento_docente == null) {
    data.nota_asesoramiento_docente = '';
  }
  if (typeof data.nota_asesoramiento_docente !== 'string') {
    throw _crearError('RESPUESTA_IA_INVALIDA', 502,
      'nota_asesoramiento_docente debe ser string (vacío permitido).');
  }
  if (data.nota_asesoramiento_docente.trim().length === 0) {
    console.warn(
      '[EVALUAR][AUDIT] nota_asesoramiento_docente llegó vacía. ' +
      'El profesor no recibirá orientación automática para la corrección del 40%. ' +
      'Revisar comportamiento del modelo si se repite.'
    );
  }
}

// ============================================================================
// SECCIÓN M — CORS, ERRORES Y AUDITORÍA
// ============================================================================

function _setCorsHeaders(req, res) {
  const origin = req.headers.origin || '';
  const esOrigenPermitido = CONFIG.cors_origins_permitidos.includes(origin)
    || /^http:\/\/localhost(:\d+)?$/.test(origin)
    || /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin);

  if (esOrigenPermitido) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function _crearError(codigo, httpStatus, mensaje) {
  const err = new Error(mensaje);
  err.codigo = codigo;
  err.httpStatus = httpStatus;
  return err;
}

function _crearResError(res, status, codigo, mensaje) {
  return res.status(status).json({ error: { codigo, mensaje } });
}

function _manejarError(res, err) {
  console.error('[EVALUAR][ERROR]', err.codigo || 'UNKNOWN', err.message);
  const status = err.httpStatus || 500;
  return res.status(status).json({
    error: {
      codigo: err.codigo || 'INTERNAL_ERROR',
      mensaje: err.message || 'Error desconocido.',
    },
  });
}

function _logAuditoria(payload, respuesta, esmock, destinatario) {
  const log = {
    ts: new Date().toISOString(),
    caso_id: payload.caso_id,
    alumno_hash: _hash(payload.alumno?.nombre || ''),
    grupo: payload.alumno?.grupo || null,
    destinatario,
    nota: respuesta?.nota_global,
    knockouts: respuesta?.knockouts_aplicados?.length || 0,
    mock: !!esmock,
  };
  console.log('[EVALUAR][OK]', JSON.stringify(log));
}

function _hash(str) {
  if (!str) return 'sin-dato';
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 12);
}

/**
 * Comparación timing-safe para evitar ataques de timing en el endpoint docente.
 */
function _compararTokensConstante(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ============================================================================
 * FIN — api/evaluar.js v2.0
 *
 * Variables de entorno necesarias en Vercel:
 *   ANTHROPIC_API_KEY    = sk-ant-...
 *   PROFESOR_TOKEN       = string aleatorio largo (mínimo 16 chars)
 *   DARABIA_MOCK         = true   (opcional, modo sin API)
 *
 * Despliegue: el archivo va en /api/evaluar.js dentro del proyecto Vercel.
 * El JSON del caso vive en /api/casos/psicosocial_gestoria.json.
 * ============================================================================ */
