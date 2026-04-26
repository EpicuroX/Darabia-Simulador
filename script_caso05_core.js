/* ============================================================================
 * DARABIA ENGINE V5 — MOTOR CIEGO
 * script_caso05_core.js · v5.1.0
 * Autor: Honás Darabia (Jonás Agudo Osuna) · IES Virgen del Pilar, Zaragoza
 * Módulo: Psicosociología Aplicada (PRL) · Curso 2025-2026
 *
 * CAMBIOS v5.1.0 RESPECTO A v5.0.0:
 *   · MOTOR.api_endpoint apunta a /api/evaluar?destinatario=alumno (explícito).
 *   · _validarRespuestaIA actualizado:
 *       - Exige campos pedagógicos (perfil_tecnico, que_has_hecho_bien,
 *         que_puedes_mejorar).
 *       - Ya NO exige nota_asesoramiento_docente (no llega al alumno).
 *       - Validación negativa: si por error llegasen campos docentes al
 *         cliente, los limpia y emite warning. Defensa en profundidad.
 *   · Resto del motor: idéntico.
 *
 * FILOSOFÍA (sin cambios):
 *   Este motor no sabe qué caso ejecuta. Lee un JSON externo y orquesta flujo,
 *   estado, persistencia y llamada al evaluador. Cero criterios de evaluación
 *   hardcodeados. Cero nombres de NPCs. Cero pesos de rúbrica. Todo vive en
 *   psicosocial_gestoria.json (u otro JSON del caso que se le pase).
 *
 * INTERMODULARIDAD (contrato innegociable):
 *   Para ejecutar el Caso 06 el año que viene: se copia este motor tal cual y
 *   se cambia solo MOTOR.caso_json_path. Cero refactor entre casos.
 *
 * FLUJO (7 fases):
 *   portada → bienvenida → expediente → metodo → entrevistas → dictamen → evaluacion
 *
 * PAYLOAD LONGITUDINAL:
 *   La evaluación devuelve vector_ejes[] para acumular perfil de competencias
 *   por alumno a lo largo del curso.
 * ============================================================================ */

'use strict';

/* ============================================================================
 * SECCIÓN A — CONFIGURACIÓN DEL MOTOR
 * ============================================================================ */

const MOTOR = {
    version: '5.0.0', // versión semver del contrato motor↔backend
    caso_json_path: './psicosocial_gestoria.json',
    api_endpoint: '/api/evaluar?destinatario=alumno',
    storage_prefix: 'darabia_v5_',
    autosave_interval_ms: 15000,
    api_timeout_ms: 45000,
    api_max_reintentos: 3,
    flujo: ['portada', 'bienvenida', 'expediente', 'metodo', 'entrevistas', 'dictamen', 'evaluacion']
};

/* ============================================================================
 * SECCIÓN B — CONEXIÓN SCORM (pipwerks · Aeducar/Moodle)
 * ============================================================================ */

const SCORM = {
    pipwerks: (typeof pipwerks !== 'undefined') ? pipwerks.SCORM : null,
    conectado: false,

    conectar() {
        if (!this.pipwerks) {
            console.log('[SCORM] pipwerks no disponible → modo local.');
            return false;
        }
        this.conectado = this.pipwerks.init();
        console.log(this.conectado ? '[SCORM] Conectado al LMS.' : '[SCORM] Modo local.');
        return this.conectado;
    },

    enviarNotaFinal(notaSobre100) {
        if (!this.conectado) return;
        try {
            const nota = Math.max(0, Math.min(100, Math.round(notaSobre100)));
            this.pipwerks.set('cmi.core.score.raw', nota.toString());
            this.pipwerks.set('cmi.core.score.min', '0');
            this.pipwerks.set('cmi.core.score.max', '100');
            this.pipwerks.set('cmi.core.lesson_status', 'completed');
            this.pipwerks.save();
            console.log('[SCORM] Nota enviada:', nota);
        } catch (err) {
            console.error('[SCORM] Error enviando nota:', err);
        }
    },

    cerrar() {
        if (!this.conectado) return;
        try {
            this.pipwerks.quit();
            this.conectado = false;
        } catch (err) {
            console.error('[SCORM] Error cerrando sesión:', err);
        }
    }
};

/* ============================================================================
 * SECCIÓN C — ESTADO DEL CASO Y DE LA PARTIDA
 * ============================================================================ */

let CASO = null;

let gameState = {
    caso_id: null,
    version_motor: MOTOR.version,

    alumno: { nombre: '', grupo: '', validado: false },
    modo_juego: null,

    fase_actual: 'portada',
    fases_completadas: [],

    investigacion: {
        metodo: null,
        datos_analizados: [],
        senales: [],
        pistas_recibidas: []
    },

    entrevistas: {},
    llaves: {},

    dictamen: {
        secciones: {},
        texto_completo: '',
        enviado: false,
        timestamp_envio: null,
        evaluacion_ia: null
    },

    timestamps: {
        carga_caso: null,
        inicio: null,
        ultima_actividad: null,
        fin: null,
        evaluacion: null
    }
};

/* ============================================================================
 * SECCIÓN D — CARGA DEL JSON DEL CASO
 * ============================================================================ */

async function cargarCaso() {
    try {
        const resp = await fetch(MOTOR.caso_json_path);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        CASO = await resp.json();
        validarCaso(CASO);
        gameState.caso_id = CASO.caso.id;
        gameState.timestamps.carga_caso = new Date().toISOString();
        console.log(`[MOTOR] Caso cargado: ${CASO.caso.titulo}`);
        return true;
    } catch (err) {
        console.error('[MOTOR] Error cargando caso:', err);
        mostrarErrorFatal(
            'No se pudo cargar el expediente del caso. Contacta con el profesor.',
            err.message
        );
        return false;
    }
}

function validarCaso(caso) {
    const requeridos = [
        'caso.id', 'caso.titulo',
        'npcs',
        'aciertos_criticos.ejes_evaluacion',
        'aciertos_criticos.rubrica_evaluacion.criterios',
        'aciertos_criticos.mapeo_ejes_criterios',
        'aciertos_criticos.knockout_criteria'
    ];
    for (const ruta of requeridos) {
        if (obtenerRuta(caso, ruta) === undefined) {
            throw new Error(`JSON inválido: falta ${ruta}`);
        }
    }
    const sumaPesos = caso.aciertos_criticos.rubrica_evaluacion.criterios
        .reduce((s, c) => s + (c.peso || 0), 0);
    if (sumaPesos !== 100) {
        throw new Error(`Rúbrica inválida: los pesos suman ${sumaPesos}, deberían sumar 100.`);
    }
}

function obtenerRuta(obj, ruta) {
    return ruta.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/* ============================================================================
 * SECCIÓN E — PERSISTENCIA EN localStorage
 * ============================================================================ */

const Persistencia = {
    clave() {
        const alumnoId = (gameState.alumno.nombre || 'anonimo')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '_');
        return `${MOTOR.storage_prefix}${gameState.caso_id || 'sin_caso'}_${alumnoId}`;
    },

    guardar() {
        try {
            gameState.timestamps.ultima_actividad = new Date().toISOString();
            localStorage.setItem(this.clave(), JSON.stringify(gameState));
        } catch (err) {
            console.warn('[PERSIST] Error guardando:', err);
        }
    },

    cargar() {
        try {
            const raw = localStorage.getItem(this.clave());
            if (!raw) return false;
            const estadoGuardado = JSON.parse(raw);
            if (estadoGuardado.caso_id !== gameState.caso_id) return false;
            Object.assign(gameState, estadoGuardado);
            return true;
        } catch (err) {
            console.warn('[PERSIST] Error cargando:', err);
            return false;
        }
    },

    limpiar() {
        try { localStorage.removeItem(this.clave()); } catch (_) {}
    },

    _timerAutosave: null,
    iniciarAutosave() {
        this.detenerAutosave();
        this._timerAutosave = setInterval(() => this.guardar(), MOTOR.autosave_interval_ms);
    },
    detenerAutosave() {
        if (this._timerAutosave) clearInterval(this._timerAutosave);
        this._timerAutosave = null;
    }
};

/* ============================================================================
 * SECCIÓN F — MÁQUINA DE ESTADOS DE FASES
 * ============================================================================ */

const Flujo = {
    fase() { return gameState.fase_actual; },

    indiceFase(f = gameState.fase_actual) {
        return MOTOR.flujo.indexOf(f);
    },

    puedeAvanzar() {
        return this.indiceFase() < MOTOR.flujo.length - 1;
    },

    avanzar() {
        if (!this.puedeAvanzar()) return false;
        if (!gameState.fases_completadas.includes(gameState.fase_actual)) {
            gameState.fases_completadas.push(gameState.fase_actual);
        }
        gameState.fase_actual = MOTOR.flujo[this.indiceFase() + 1];
        Persistencia.guardar();
        renderizarFase();
        return true;
    },

    irA(fase) {
        if (!MOTOR.flujo.includes(fase)) {
            console.warn(`[FLUJO] Fase desconocida: ${fase}`);
            return false;
        }
        gameState.fase_actual = fase;
        Persistencia.guardar();
        renderizarFase();
        return true;
    }
};

/* ============================================================================
 * SECCIÓN G — LÓGICA DE ENTREVISTAS
 * ============================================================================ */

const Entrevistas = {
    iniciarNPC(npcId) {
        if (!gameState.entrevistas[npcId]) {
            gameState.entrevistas[npcId] = { preguntas: [], respuestas: [], llaves: [] };
        }
    },

    registrarPregunta(npcId, preguntaId, pregunta, respuesta) {
        this.iniciarNPC(npcId);
        const entry = gameState.entrevistas[npcId];
        entry.preguntas.push({ id: preguntaId, texto: pregunta, ts: new Date().toISOString() });
        entry.respuestas.push({ id: preguntaId, texto: respuesta, ts: new Date().toISOString() });
        Persistencia.guardar();
    },

    intentarDesbloquear(npcId, preguntaAlumno) {
        const npc = CASO.npcs.find(n => n.id === npcId);
        if (!npc || !Array.isArray(npc.evidencias_desbloqueables)) return [];
        const desbloqueadas = [];
        for (const ev of npc.evidencias_desbloqueables) {
            if (gameState.llaves[ev.id]) continue;
            if (coincidenciaPregunta(preguntaAlumno, ev.pregunta_dardo)) {
                gameState.llaves[ev.id] = {
                    desbloqueada: true,
                    origen: npcId,
                    evidencia: ev.evidencia,
                    timestamp: new Date().toISOString()
                };
                this.iniciarNPC(npcId);
                gameState.entrevistas[npcId].llaves.push(ev.id);
                desbloqueadas.push(ev);
            }
        }
        if (desbloqueadas.length) Persistencia.guardar();
        return desbloqueadas;
    }
};

function coincidenciaPregunta(preguntaAlumno, preguntaDardo) {
    if (!preguntaAlumno || !preguntaDardo) return false;
    const norm = s => s.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/).filter(w => w.length > 3);
    const pa = new Set(norm(preguntaAlumno));
    const pd = norm(preguntaDardo);
    if (pd.length === 0) return false;
    const coincidencias = pd.filter(w => pa.has(w)).length;
    return (coincidencias / pd.length) >= 0.5;
}

/* ============================================================================
 * SECCIÓN G.bis — TRAZABILIDAD DE PISTAS
 * ============================================================================ */

const Pistas = {
    registrar(origen, contenido, nivel = null) {
        gameState.investigacion.pistas_recibidas.push({
            origen: origen || 'desconocido',
            contenido: contenido || '',
            nivel: nivel,
            timestamp: new Date().toISOString(),
            fase: gameState.fase_actual
        });
        Persistencia.guardar();
    },

    total() {
        return gameState.investigacion.pistas_recibidas.length;
    },

    porNivel() {
        const conteo = {};
        for (const p of gameState.investigacion.pistas_recibidas) {
            const k = p.nivel || 'sin_nivel';
            conteo[k] = (conteo[k] || 0) + 1;
        }
        return conteo;
    }
};

/* ============================================================================
 * SECCIÓN H — DICTAMEN
 * ============================================================================ */

const Dictamen = {
    secciones() {
        return CASO.aciertos_criticos.rubrica_evaluacion.criterios.map(c => ({
            id: c.id,
            etiqueta: c.nombre,
            ayuda: c.descripcion,
            peso: c.peso
        }));
    },

    setSeccion(criterioId, texto) {
        gameState.dictamen.secciones[criterioId] = texto || '';
        gameState.dictamen.texto_completo = this.componerTextoCompleto();
        Persistencia.guardar();
    },

    getSeccion(criterioId) {
        return gameState.dictamen.secciones[criterioId] || '';
    },

    componerTextoCompleto() {
        return this.secciones().map(sec => {
            const cuerpo = gameState.dictamen.secciones[sec.id] || '';
            return `## ${sec.etiqueta}\n\n${cuerpo.trim()}\n`;
        }).join('\n');
    },

    validar() {
        const faltan = this.secciones()
            .filter(sec => !(gameState.dictamen.secciones[sec.id] || '').trim())
            .map(sec => sec.etiqueta);
        return { valido: faltan.length === 0, secciones_vacias: faltan };
    }
};

/* ============================================================================
 * SECCIÓN I — WRAPPER DE LLAMADA AL EVALUADOR (proxy Vercel)
 * ============================================================================
 * Llamada única al final del flujo. El cliente del alumno SIEMPRE invoca
 * /api/evaluar?destinatario=alumno. Recibe únicamente el bloque pedagógico.
 *
 * El bloque docente NO llega al cliente del alumno. Si el profesor necesita
 * el feedback técnico, lo obtiene desde corrector.html re-evaluando el texto
 * del dictamen — proceso completamente independiente.
 * ============================================================================ */

const Evaluador = {
    async enviar() {
        const validacion = Dictamen.validar();
        if (!validacion.valido) {
            throw new ErrorEvaluacion(
                'DICTAMEN_INCOMPLETO',
                `Faltan secciones: ${validacion.secciones_vacias.join(', ')}`
            );
        }

        const payload = {
            caso_id: CASO.caso.id,
            version_motor: MOTOR.version,
            modo_juego: gameState.modo_juego,
            alumno: gameState.alumno,
            dictamen: {
                secciones: gameState.dictamen.secciones,
                texto_completo: Dictamen.componerTextoCompleto()
            },
            llaves_desbloqueadas: Object.keys(gameState.llaves),
            entrevistas_resumen: this._resumirEntrevistas(),
            timestamp_envio: new Date().toISOString()
        };

        gameState.dictamen.enviado = true;
        gameState.dictamen.timestamp_envio = payload.timestamp_envio;
        Persistencia.guardar();

        return await this._llamarConReintentos(payload);
    },

    _resumirEntrevistas() {
        const res = {};
        for (const [npcId, data] of Object.entries(gameState.entrevistas)) {
            res[npcId] = {
                n_preguntas: data.preguntas.length,
                llaves_obtenidas: data.llaves
            };
        }
        return res;
    },

    async _llamarConReintentos(payload, intento = 1) {
        try {
            const resp = await this._fetch(payload);
            if (resp.status === 429 || resp.status === 402) {
                throw new ErrorEvaluacion(
                    resp.status === 429 ? 'LIMITE_CUOTA' : 'SIN_SALDO',
                    `Respuesta ${resp.status} del proxy.`
                );
            }
            if (!resp.ok) throw new ErrorEvaluacion('HTTP_ERROR', `HTTP ${resp.status}`);

            const data = await resp.json();
            this._validarRespuestaIA(data);

            gameState.dictamen.evaluacion_ia = data;
            gameState.timestamps.fin = new Date().toISOString();
            gameState.timestamps.evaluacion = gameState.timestamps.fin;
            Persistencia.guardar();
            return data;

        } catch (err) {
            const esRed = err.name === 'TypeError' || err.name === 'AbortError';
            if (esRed && intento < MOTOR.api_max_reintentos) {
                const espera = 1000 * Math.pow(2, intento);
                console.warn(`[EVAL] Reintento ${intento + 1} en ${espera}ms`);
                await new Promise(r => setTimeout(r, espera));
                return this._llamarConReintentos(payload, intento + 1);
            }
            throw err;
        }
    },

    async _fetch(payload) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), MOTOR.api_timeout_ms);
        try {
            return await fetch(MOTOR.api_endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeoutId);
        }
    },

    /**
     * Valida que la respuesta contiene el bloque pedagógico que la UI necesita.
     *
     * Campos REQUERIDOS:
     *   · nota_global (0-100)   — o puntuacion_total (alias por compatibilidad)
     *   · vector_ejes           — array completo según ejes_evaluacion del JSON
     *   · perfil_tecnico        — string (1-2 frases)
     *   · que_has_hecho_bien    — array de strings
     *   · que_puedes_mejorar    — array de strings
     *
     * Campos OPCIONALES (aceptados, no obligatorios):
     *   · errores_clave_pedagogicos / errores_clave (alias)
     *   · error_critico
     *   · evaluacion_criterios (mapa criterio_id → 0-10, para barras UI)
     *   · detalle_criterios (estructura cruda del modelo)
     *
     * Validación NEGATIVA — defensa en profundidad:
     *   El cliente del alumno NUNCA debería recibir contenido docente. Si por
     *   un fallo del backend llegasen los siguientes campos, los limpiamos y
     *   emitimos warning. Esto NO sustituye la separación en el backend, pero
     *   añade una capa más de protección frente a errores futuros.
     */
    _validarRespuestaIA(data) {
        // Compat: dual-naming nota_global / puntuacion_total
        const tieneNotaGlobal = typeof data?.nota_global === 'number';
        const tienePuntuacionTotal = typeof data?.puntuacion_total === 'number';

        if (!tieneNotaGlobal && !tienePuntuacionTotal) {
            throw new ErrorEvaluacion(
                'RESPUESTA_INVALIDA',
                'Falta nota numérica (nota_global o puntuacion_total).'
            );
        }
        if (!tieneNotaGlobal && tienePuntuacionTotal) {
            console.warn('[EVAL] Backend devolvió "puntuacion_total". Normalizando a "nota_global".');
            data.nota_global = data.puntuacion_total;
        }

        if (!Array.isArray(data.vector_ejes)) {
            throw new ErrorEvaluacion('RESPUESTA_INVALIDA', 'Falta vector_ejes (array).');
        }
        const ejesEsperados = CASO.aciertos_criticos.ejes_evaluacion;
        const ejesRecibidos = data.vector_ejes.map(e => e.eje);
        for (const eje of ejesEsperados) {
            if (!ejesRecibidos.includes(eje)) {
                throw new ErrorEvaluacion(
                    'RESPUESTA_INVALIDA',
                    `Falta eje "${eje}" en vector_ejes.`
                );
            }
        }

        // Bloque pedagógico requerido
        if (typeof data.perfil_tecnico !== 'string' || data.perfil_tecnico.trim().length < 5) {
            throw new ErrorEvaluacion('RESPUESTA_INVALIDA', 'Falta perfil_tecnico (string).');
        }
        if (!Array.isArray(data.que_has_hecho_bien)) {
            throw new ErrorEvaluacion('RESPUESTA_INVALIDA', 'Falta que_has_hecho_bien (array).');
        }
        if (!Array.isArray(data.que_puedes_mejorar)) {
            throw new ErrorEvaluacion('RESPUESTA_INVALIDA', 'Falta que_puedes_mejorar (array).');
        }

        // Validación NEGATIVA: limpieza defensiva de campos docentes que
        // jamás deberían llegar al cliente del alumno.
        const camposProhibidos = [
            'nota_asesoramiento_docente',
            'sugerencia_calificacion_40_manual',
            'alertas_correccion',
            'knockouts_aplicados'
        ];
        let huboFuga = false;
        for (const campo of camposProhibidos) {
            if (campo in data) {
                console.warn(
                    `[EVAL][SEGURIDAD] Campo docente "${campo}" presente en respuesta al alumno. ` +
                    'Eliminando del cliente. Revisar bifurcación del backend.'
                );
                delete data[campo];
                huboFuga = true;
            }
        }
        if (huboFuga) {
            console.warn(
                '[EVAL][SEGURIDAD] La respuesta del backend contenía contenido docente. ' +
                'Se ha limpiado en cliente, pero el backend NO debería enviar esos campos al destinatario alumno.'
            );
        }
    }
};

class ErrorEvaluacion extends Error {
    constructor(codigo, mensaje) {
        super(mensaje);
        this.name = 'ErrorEvaluacion';
        this.codigo = codigo;
    }
}

/* ============================================================================
 * SECCIÓN J — CÁLCULO DE NOTA FINAL HÍBRIDA (60 auto + 40 prof)
 * ============================================================================
 * En v5.1 esta utilidad sigue siendo accesible (Darabia.Calificacion), pero
 * la nota final híbrida la calcula y comunica el profesor por canales externos
 * al simulador (corrector.html + libreta de calificaciones del LMS).
 * ============================================================================ */

const Calificacion = {
    calcularNotaFinal(notaAutomatica0a100, notaProfesor0a100) {
        const pesoAuto = CASO.caso.puntuacion_maxima_automatica;
        const pesoProf = CASO.caso.puntuacion_profesor;
        const total = pesoAuto + pesoProf;
        if (total !== 100) {
            console.warn(`[CALIF] pesos auto+prof = ${total}, normalizo sobre 100.`);
        }
        const auto = (notaAutomatica0a100 / 100) * pesoAuto;
        const prof = (notaProfesor0a100 / 100) * pesoProf;
        return Math.round((auto + prof) * 100) / 100;
    },

    extraerVectorEjes(evaluacionIA) {
        if (!evaluacionIA?.vector_ejes) return [];
        return evaluacionIA.vector_ejes.map(e => ({
            eje: e.eje,
            puntuacion: e.puntuacion,
            max: e.max
        }));
    }
};

/* ============================================================================
 * SECCIÓN K — RENDERER (delega en DarabiaUI del Paso 4)
 * ============================================================================ */

function renderizarFase() {
    const fase = gameState.fase_actual;
    console.log(`[RENDER] Fase: ${fase}`);

    const contenedor = document.getElementById('darabia-root');
    if (!contenedor) return;

    if (typeof window.DarabiaUI?.render === 'function') {
        window.DarabiaUI.render(fase, { CASO, gameState, Flujo, Entrevistas, Dictamen, Evaluador });
    }
}

function mostrarErrorFatal(mensaje, detalle) {
    const c = document.getElementById('darabia-root');
    if (!c) return;
    c.innerHTML = `
        <div style="padding:24px; color:#ff4d6a; font-family:Inter,sans-serif;">
            <h2>No se puede arrancar el simulador</h2>
            <p>${mensaje}</p>
            <pre style="font-family:JetBrains Mono,monospace; font-size:.85rem; opacity:.7;">${detalle || ''}</pre>
        </div>`;
}

/* ============================================================================
 * SECCIÓN L — API PÚBLICA
 * ============================================================================ */

const Darabia = {
    MOTOR, SCORM, Flujo, Entrevistas, Pistas, Dictamen, Evaluador, Calificacion, Persistencia,
    get caso() { return CASO; },
    get estado() { return gameState; },

    async iniciar() {
        SCORM.conectar();
        const ok = await cargarCaso();
        if (!ok) return false;
        Persistencia.cargar();
        Persistencia.iniciarAutosave();
        renderizarFase();
        return true;
    },

    registrarAlumno(nombre, grupo) {
        const nombreLimpio = (nombre || '').trim();
        const grupoLimpio = (grupo || '').trim();
        if (!nombreLimpio) {
            console.warn('[DARABIA] Nombre vacío: registro rechazado.');
            return false;
        }
        gameState.alumno = {
            nombre: nombreLimpio,
            grupo: grupoLimpio,
            validado: true
        };
        if (!gameState.timestamps.inicio) {
            gameState.timestamps.inicio = new Date().toISOString();
        }
        Persistencia.guardar();
        return true;
    },

    setModoJuego(modo) {
        const modosPermitidos = CASO?.modos_disponibles;
        if (Array.isArray(modosPermitidos) && modosPermitidos.length > 0) {
            if (!modosPermitidos.includes(modo)) {
                console.warn(`[DARABIA] Modo "${modo}" no está en CASO.modos_disponibles:`, modosPermitidos);
                return false;
            }
        } else if (!modo || typeof modo !== 'string') {
            console.warn('[DARABIA] Modo inválido (string vacío).');
            return false;
        }
        gameState.modo_juego = modo;
        Persistencia.guardar();
        return true;
    },

    async finalizar() {
        Persistencia.detenerAutosave();
        if (!gameState.timestamps.fin) {
            gameState.timestamps.fin = new Date().toISOString();
        }
        if (gameState.dictamen.evaluacion_ia?.nota_global != null) {
            const notaParaScorm = gameState.dictamen.evaluacion_ia.nota_global;
            SCORM.enviarNotaFinal(notaParaScorm);
        }
        SCORM.cerrar();
    },

    reiniciar() {
        Persistencia.detenerAutosave();
        Persistencia.limpiar();
        location.reload();
    }
};

if (typeof window !== 'undefined') {
    window.Darabia = Darabia;
}

/* ============================================================================
 * FIN · script_caso05_core.js · v5.1.0
 * ============================================================================ */
