/* ==========================================================================
   DARABIA ENGINE V5 · CONSOLA DE PERITAJE PSICOSOCIAL
   script_ui.js · Fase 4 · Capa de presentación
   ──────────────────────────────────────────────────────────────────────────
   Este archivo NO modifica el motor (script_caso05_core.js) ni el backend.
   Consume window.Darabia como fachada pública (Flujo, Entrevistas, Dictamen,
   Evaluador, Calificacion, Persistencia + estado/caso).

   Expone window.DarabiaUI con:
     UI.setEstado(estado)      → 'investigacion' | 'redaccion' | 'evaluando' | 'resultado'
     UI.renderResultado(eval)  → pinta el overlay de evaluación
     UI.updateEvidencias()     → recuenta y refresca contadores
     UI.updateChat()           → repinta stream + lista de NPCs
     UI.render(fase, ctx)      → entry point que el motor llama en renderizarFase()
   ========================================================================== */

'use strict';

(function () {

    /* ======================================================================
       0 · UTILIDADES
       ====================================================================== */
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    const el = (tag, attrs = {}, ...children) => {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === 'class') node.className = v;
            else if (k === 'data') Object.assign(node.dataset, v);
            else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
            else if (v !== false && v != null) node.setAttribute(k, v);
        }
        for (const child of children.flat()) {
            if (child == null || child === false) continue;
            node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
        }
        return node;
    };

    const escapeHtml = (s) => String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const ahora = () => {
        const d = new Date();
        const pad = n => n.toString().padStart(2, '0');
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    const debounce = (fn, ms) => {
        let t = null;
        return (...args) => {
            clearTimeout(t);
            t = setTimeout(() => fn(...args), ms);
        };
    };

    const initials = (nombre) => (nombre || '')
        .trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();


    /* ======================================================================
       1 · ESTADO DE LA UI (independiente del gameState del motor)
       ====================================================================== */
    const UIState = {
        estadoActual: 'investigacion',     // visual: investigacion | redaccion | evaluando | resultado
        npcActivo: null,                    // id del NPC en chat
        seccionActiva: null,                // id del criterio activo en el editor
        modalAbierto: false,
        guardadoTimer: null,
        // Asociación determinista pregunta → evidencias desbloqueadas en ese turno.
        // Vive en la UI porque es metadato de presentación; el motor mantiene su
        // gameState intacto. Mapa: { preguntaId: [evIds...] }
        evidenciasPorTurno: {},
        // Set de NPCs ya entrevistados (al menos una pregunta enviada).
        // Controla la visibilidad de transcripciones en el modal del expediente.
        npcsEntrevistados: new Set(),
    };


    /* ======================================================================
       2 · SHELL: DOM PRINCIPAL DE LA CONSOLA
       ====================================================================== */
    function montarShell() {
        const root = $('#darabia-root');
        if (!root) return;
        root.innerHTML = '';
        document.body.classList.add('estado-investigacion');

        // TOPBAR
        const caso = window.Darabia?.caso?.caso;
        const tituloCaso = caso?.titulo || 'Expediente psicosocial';
        const idCaso = caso?.id || '—';

        const topbar = el('div', { class: 'topbar' },
            el('div', { class: 'topbar-brand' },
                el('div', { class: 'topbar-mark' }, 'D'),
                el('div', null,
                    el('div', { class: 'topbar-title' }, 'DARABIA · Consola de Peritaje'),
                    el('div', { class: 'topbar-sub' }, `${tituloCaso} · ${idCaso}`)
                )
            ),
            el('div', { class: 'topbar-actions' },
                el('button', {
                    class: 'topbar-btn',
                    id: 'btn-expediente',
                    title: 'Abrir expediente literal',
                    onclick: abrirExpediente
                },
                    el('span', { class: 'dot' }), 'Expediente'
                )
            )
        );
        root.appendChild(topbar);

        // HUD
        const hud = el('div', { class: 'hud' },
            el('div', { class: 'hud-metric' },
                el('div', { class: 'hud-label' }, 'Evidencias'),
                el('div', { class: 'hud-bar' },
                    el('div', { class: 'hud-bar-fill', id: 'hud-evid-bar' })
                ),
                el('div', { class: 'hud-value', id: 'hud-evid-value' }, '0/0')
            ),
            el('div', { class: 'hud-metric' },
                el('div', { class: 'hud-label' }, 'Palabras dictamen'),
                el('div', { class: 'hud-value', id: 'hud-words-value' }, '0')
            ),
            el('div', { class: 'hud-spacer' }),
            el('div', { class: 'hud-phase', id: 'hud-phase' },
                'Fase · ', el('strong', null, 'Investigación')
            )
        );
        root.appendChild(hud);

        // WORKSPACE 3 paneles
        const workspace = el('div', { class: 'workspace', id: 'workspace' });
        workspace.appendChild(montarPanelIzq());
        workspace.appendChild(montarPanelChat());
        workspace.appendChild(montarPanelEditor());
        root.appendChild(workspace);

        // Drawers móvil
        root.appendChild(el('button', {
            class: 'panel-toggle left mobile-only',
            onclick: () => document.body.classList.toggle('drawer-left-open')
        }, 'NPC'));
        root.appendChild(el('button', {
            class: 'panel-toggle right mobile-only',
            onclick: () => document.body.classList.toggle('drawer-right-open')
        }, 'EDIT'));

        // Overlays + modal + toasts
        root.appendChild(montarEvalOverlay());
        root.appendChild(montarResultOverlay());
        root.appendChild(montarModal());
        root.appendChild(el('div', { class: 'toast-host', id: 'toast-host' }));
    }


    /* ======================================================================
       3 · PANEL IZQUIERDO · NPCs (eje principal) + Documentos secundarios
       ====================================================================== */
    function montarPanelIzq() {
        const npcs = window.Darabia?.caso?.npcs || [];
        const totalEvidencias = npcs.reduce(
            (acc, n) => acc + (n.evidencias_desbloqueables?.length || 0), 0);

        const panel = el('aside', { class: 'panel panel-left' },
            el('div', { class: 'panel-header' },
                el('div', { class: 'panel-title' }, 'Investigación'),
                el('div', { class: 'panel-title-meta', id: 'panel-left-meta' },
                    `0 / ${totalEvidencias} ev.`)
            ),
            el('div', { class: 'panel-body', id: 'panel-left-body' })
        );
        return panel;
    }

    function renderPanelIzq() {
        const body = $('#panel-left-body');
        if (!body) return;
        const npcs = window.Darabia?.caso?.npcs || [];
        const llaves = window.Darabia?.estado?.llaves || {};
        const entrevistas = window.Darabia?.estado?.entrevistas || {};

        body.innerHTML = '';

        // Lista NPCs
        const list = el('div', { class: 'npc-list' });
        npcs.forEach(npc => {
            const ev = npc.evidencias_desbloqueables || [];
            const desbloqueadas = ev.filter(e => llaves[e.id]).length;
            const totalEv = ev.length;
            const preguntas = entrevistas[npc.id]?.preguntas?.length || 0;

            let estado = 'no-iniciado';
            let estadoTxt = 'Sin iniciar';
            if (preguntas > 0 && desbloqueadas < totalEv) { estado = 'en-progreso'; estadoTxt = 'En curso'; }
            if (totalEv > 0 && desbloqueadas === totalEv) { estado = 'completado'; estadoTxt = 'Completo'; }

            const card = el('button', {
                class: 'npc-card' + (UIState.npcActivo === npc.id ? ' is-active' : ''),
                onclick: () => seleccionarNPC(npc.id)
            },
                el('div', { class: 'npc-head' },
                    el('div', { class: 'npc-avatar' }, initials(npc.nombre)),
                    el('div', { class: 'npc-info' },
                        el('div', { class: 'npc-name' }, npc.nombre),
                        el('div', { class: 'npc-rol' }, npc.rol || '')
                    )
                ),
                el('div', { class: 'npc-meta' },
                    el('div', { class: 'npc-state ' + estado },
                        el('span', { class: 'pip' }), estadoTxt
                    ),
                    totalEv > 0
                        ? el('div', { class: 'npc-evid-count' }, `${desbloqueadas}/${totalEv} ev.`)
                        : el('div', { class: 'npc-evid-count' }, 'Sin llaves')
                )
            );
            list.appendChild(card);
        });
        body.appendChild(list);

        // Documentos del expediente (contenido secundario)
        body.appendChild(
            el('div', { class: 'panel-side-section' },
                el('div', { class: 'panel-side-title' }, 'Documentos del expediente'),
                el('button', {
                    class: 'doc-link',
                    onclick: () => abrirExpediente('fichaje')
                },
                    el('div', { class: 'doc-ico' }, '⏱'),
                    el('span', null, 'Registro horario · semana 13–19 abr')
                ),
                el('button', {
                    class: 'doc-link',
                    onclick: () => abrirExpediente('istas')
                },
                    el('div', { class: 'doc-ico' }, '%'),
                    el('span', null, 'Resultados ISTAS21 · marzo 2026')
                ),
                el('button', {
                    class: 'doc-link',
                    onclick: () => abrirExpediente('bandeja')
                },
                    el('div', { class: 'doc-ico' }, '✉'),
                    el('span', null, 'Bandeja Outlook · Ana · 09:47')
                ),
                el('button', {
                    class: 'doc-link',
                    onclick: () => abrirExpediente('contrato')
                },
                    el('div', { class: 'doc-ico' }, '§'),
                    el('span', null, 'Contrato Miguel · Cláusula 3ª')
                ),
                el('button', {
                    class: 'doc-link',
                    onclick: () => abrirExpediente('bajas')
                },
                    el('div', { class: 'doc-ico' }, '⊕'),
                    el('span', null, 'Partes IT 2025–2026')
                )
            )
        );

        // Actualizar contador panel
        const totalE = npcs.reduce((acc, n) => acc + (n.evidencias_desbloqueables?.length || 0), 0);
        const desbloqE = Object.keys(llaves).length;
        $('#panel-left-meta').textContent = `${desbloqE} / ${totalE} ev.`;
    }


    /* ======================================================================
       4 · PANEL CENTRAL · Chat profesional
       ====================================================================== */
    function montarPanelChat() {
        return el('main', { class: 'panel panel-chat' },
            el('div', { class: 'chat-context empty', id: 'chat-context' },
                'Selecciona un NPC en el panel de la izquierda para iniciar la entrevista.'
            ),
            el('div', { class: 'chat-stream', id: 'chat-stream' },
                el('div', { class: 'chat-empty' },
                    el('div', { class: 'chat-empty-icon' }, '◌'),
                    el('div', null,
                        'No se ha iniciado ninguna entrevista. ',
                        el('br'),
                        el('span', { style: 'color:var(--text-3);font-family:var(--mono);font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;' },
                            'Tu trabajo empieza por preguntar.'
                        )
                    )
                )
            ),
            // El contenido de chat-input-wrap lo gestiona renderChatInputArea(estado).
            el('div', { class: 'chat-input-wrap', id: 'chat-input-wrap' })
        );
    }

    function ajustarInput(e) {
        const ta = e.target;
        ta.style.height = 'auto';
        ta.style.height = Math.min(140, ta.scrollHeight) + 'px';

        const send = $('#chat-send-btn');
        if (send) send.disabled = !ta.value.trim() || !UIState.npcActivo;
    }

    function onKeyChat(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!$('#chat-send-btn').disabled) enviarPregunta();
        }
    }

    function seleccionarNPC(npcId) {
        UIState.npcActivo = npcId;
        const npc = window.Darabia?.caso?.npcs?.find(n => n.id === npcId);
        if (!npc) return;

        // Inicializar entrevista en el motor
        window.Darabia.Entrevistas.iniciarNPC(npcId);

        // Si veníamos de redacción y el alumno vuelve al chat, descomprimir paneles
        if (UIState.estadoActual === 'redaccion') {
            UI.setEstado('investigacion');
        }

        renderPanelIzq();
        renderChatContext(npc);
        renderChatStream();

        const input = $('#chat-input');
        if (input) {
            input.disabled = false;
            input.focus();
        }
        const send = $('#chat-send-btn');
        if (send) send.disabled = !input?.value.trim();
    }

    /**
     * Reconstruye los sets de UI a partir del gameState persistido. Llamado en
     * boot para que un alumno que vuelve a la sesión vea correctamente sus
     * transcripciones desbloqueadas y sus turnos asociados a evidencias.
     */
    function reconstruirEstadoUI() {
        const entrevistas = window.Darabia?.estado?.entrevistas || {};

        // NPCs ya entrevistados
        for (const [npcId, data] of Object.entries(entrevistas)) {
            if ((data?.preguntas || []).length > 0) {
                UIState.npcsEntrevistados.add(npcId);
            }
        }

        // Evidencias por turno: las inferimos por proximidad temporal (única vez,
        // al recuperar sesión). En sesiones nuevas, la asociación va por ID en
        // tiempo real (ver enviarPregunta).
        const llaves = window.Darabia?.estado?.llaves || {};
        for (const [npcId, data] of Object.entries(entrevistas)) {
            const npc = window.Darabia.caso.npcs.find(n => n.id === npcId);
            if (!npc) continue;
            const evDesbloqDelNpc = (npc.evidencias_desbloqueables || [])
                .filter(ev => llaves[ev.id]);

            for (let i = 0; i < (data.preguntas || []).length; i++) {
                const p = data.preguntas[i];
                const r = data.respuestas[i];
                if (!r || !r.texto || r.texto.trim().length === 0) continue;
                const matches = evDesbloqDelNpc.filter(ev => {
                    const llave = llaves[ev.id];
                    return llave && Math.abs(new Date(llave.timestamp) - new Date(r.ts)) < 5000;
                });
                if (matches.length > 0) {
                    UIState.evidenciasPorTurno[p.id] = matches.map(m => m.id);
                }
            }
        }
    }

    function renderChatContext(npc) {
        const ctx = $('#chat-context');
        if (!ctx) return;
        ctx.classList.remove('empty');
        ctx.innerHTML = '';

        const ev = npc.evidencias_desbloqueables || [];
        const llaves = window.Darabia?.estado?.llaves || {};
        const desbloq = ev.filter(e => llaves[e.id]).length;

        ctx.appendChild(el('div', { class: 'chat-context-avatar' }, initials(npc.nombre)));
        ctx.appendChild(el('div', { class: 'chat-context-info' },
            el('div', { class: 'chat-context-name' }, npc.nombre),
            el('div', { class: 'chat-context-rol' }, npc.rol || '')
        ));
        ctx.appendChild(el('div', { class: 'chat-context-state' },
            ev.length ? `Evidencias · ${desbloq}/${ev.length}` : 'Sin llaves'
        ));
    }

    function renderChatStream() {
        const stream = $('#chat-stream');
        if (!stream) return;
        stream.innerHTML = '';

        const npcId = UIState.npcActivo;
        if (!npcId) return;

        const npc = window.Darabia.caso.npcs.find(n => n.id === npcId);
        const entrevista = window.Darabia.estado.entrevistas[npcId];

        if (!entrevista || entrevista.preguntas.length === 0) {
            // Mensaje de sistema inicial: contexto del NPC
            stream.appendChild(turnoSistema(
                `Entrevista preliminar · ${npc.nombre} · ${npc.edad ? npc.edad + ' años · ' : ''}${npc.rol}` +
                (npc.nota_tecnica ? `\n\n${npc.nota_tecnica}` : '')
            ));
            return;
        }

        // Renderizar histórico de turnos
        for (let i = 0; i < entrevista.preguntas.length; i++) {
            const p = entrevista.preguntas[i];
            const r = entrevista.respuestas[i];

            stream.appendChild(turnoUsuario(p.texto, p.ts));

            // Asociación determinista por ID: ¿esta pregunta desbloqueó algo?
            const evIds = UIState.evidenciasPorTurno[p.id] || [];

            if (r && r.texto && r.texto.trim().length > 0) {
                // Hay respuesta literal del expediente → mostrar turno del NPC
                stream.appendChild(turnoNPC(npc, r.texto, r.ts));

                // Tarjetas de evidencia asociadas a este turno (por ID)
                evIds.forEach(evId => {
                    const ev = (npc.evidencias_desbloqueables || []).find(e => e.id === evId);
                    if (ev) stream.appendChild(tarjetaEvidencia(ev));
                });
            } else {
                // Pregunta sin desbloqueo → acuse del sistema, sin invención de texto NPC
                stream.appendChild(turnoSistema(pistasPendientes(npc)));
            }
        }

        // Auto-scroll
        requestAnimationFrame(() => stream.scrollTop = stream.scrollHeight);
    }

    function turnoSistema(texto) {
        return el('div', { class: 'turn sistema' },
            el('div', { class: 'turn-meta' },
                el('span', { class: 'who is-sistema' }, 'Sistema'),
                el('span', { class: 'ts' }, ahora())
            ),
            el('div', { class: 'turn-body', style: 'white-space:pre-wrap;' }, texto)
        );
    }

    function turnoUsuario(texto, ts) {
        const alumno = window.Darabia?.estado?.alumno;
        const nombre = alumno?.nombre ? `Tú · ${alumno.nombre.split(' ')[0]}` : 'Tú · Perito';
        return el('div', { class: 'turn user' },
            el('div', { class: 'turn-meta' },
                el('span', { class: 'who is-user' }, nombre),
                el('span', { class: 'ts' }, formatearHora(ts))
            ),
            el('div', { class: 'turn-body' }, texto)
        );
    }

    function turnoNPC(npc, texto, ts) {
        return el('div', { class: 'turn npc' },
            el('div', { class: 'turn-meta' },
                el('span', { class: 'who is-npc' }, npc.nombre),
                el('span', { class: 'ts' }, formatearHora(ts))
            ),
            el('div', { class: 'turn-body' }, texto)
        );
    }

    function tarjetaEvidencia(ev) {
        const modelos = [];
        if (ev.dimension_karasek) modelos.push(`Karasek · ${ev.dimension_karasek}`);
        if (ev.dimension_siegrist) modelos.push(`Siegrist · ${ev.dimension_siegrist}`);
        if (ev.dimension_istas) modelos.push(`ISTAS21 · ${ev.dimension_istas}`);
        if (ev.requiere_protocolo_investigacion) modelos.push('⚠ Protocolo investigación');

        return el('div', { class: 'evidence-card' },
            el('div', { class: 'evidence-head' },
                el('span', { class: 'evidence-tag' }, '◆ Evidencia desbloqueada'),
                el('span', { class: 'evidence-id' }, ev.id)
            ),
            el('div', { class: 'evidence-body' }, ev.evidencia),
            modelos.length
                ? el('div', { class: 'evidence-models' },
                    ...modelos.map(m => el('span', { class: 'evidence-model-chip' }, m))
                )
                : null
        );
    }

    function formatearHora(iso) {
        if (!iso) return ahora();
        try {
            const d = new Date(iso);
            const pad = n => n.toString().padStart(2, '0');
            return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        } catch { return ahora(); }
    }


    /* ======================================================================
       5 · LÓGICA DE PREGUNTA Y RESPUESTA
       ====================================================================== */
    function enviarPregunta() {
        const input = $('#chat-input');
        if (!input) return;
        const pregunta = input.value.trim();
        if (!pregunta || !UIState.npcActivo) return;

        const npc = window.Darabia.caso.npcs.find(n => n.id === UIState.npcActivo);
        if (!npc) return;

        // 1. Intentar desbloqueo de evidencias mediante el motor
        const desbloqueadas = window.Darabia.Entrevistas.intentarDesbloquear(
            UIState.npcActivo, pregunta);

        // 2. Construir respuesta:
        //    - Si hay desbloqueo: frase literal del expediente (campo `evidencia` del JSON).
        //    - Si NO hay desbloqueo: el NPC NO produce texto inventado. Devolvemos
        //      cadena vacía y la UI mostrará un acuse del sistema en su lugar.
        const respuesta = desbloqueadas.length > 0
            ? desbloqueadas.map(d => d.evidencia).join('\n\n')
            : '';

        // 3. Registrar en el motor (clave determinista de turno)
        const preguntaId = `q_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        window.Darabia.Entrevistas.registrarPregunta(
            UIState.npcActivo, preguntaId, pregunta, respuesta);

        // 4. Asociar evidencias desbloqueadas a este turno por ID (determinista,
        //    independiente del reloj). Vive en UIState porque es metadato visual.
        if (desbloqueadas.length > 0) {
            UIState.evidenciasPorTurno[preguntaId] = desbloqueadas.map(d => d.id);
        }

        // 5. Marcar NPC como entrevistado (libera transcripción en el modal)
        UIState.npcsEntrevistados.add(UIState.npcActivo);

        // 6. Refrescar UI
        input.value = '';
        input.style.height = 'auto';
        $('#chat-send-btn').disabled = true;
        renderChatStream();
        renderPanelIzq();
        actualizarHUDEvidencias();

        if (desbloqueadas.length > 0) {
            mostrarToast(
                `${desbloqueadas.length} evidencia${desbloqueadas.length > 1 ? 's' : ''} desbloqueada${desbloqueadas.length > 1 ? 's' : ''}`,
                desbloqueadas.map(d => d.evidencia.split('.')[0]).join('. '),
                'success'
            );
        }
    }

    /**
     * Construye un acuse del sistema cuando una pregunta no ha producido
     * desbloqueo. NO inventa texto del NPC. En su lugar, sugiere temáticas que
     * aún quedan por explorar (sin chivar la frase exacta), apoyándose en los
     * IDs de las evidencias pendientes — que son nombres semánticos del JSON.
     *
     * Esta función NO genera turnos; solo produce el texto del acuse de sistema
     * que el renderer del chat insertará después del turno del usuario.
     */
    function pistasPendientes(npc) {
        const llaves = window.Darabia?.estado?.llaves || {};
        const pendientes = (npc.evidencias_desbloqueables || [])
            .filter(ev => !llaves[ev.id]);

        if (pendientes.length === 0) {
            return `Has agotado las evidencias desbloqueables de ${npc.nombre}. ` +
                   `Considera entrevistar a otro NPC o pasar a redacción.`;
        }
        // Extraer hints sin chivar literales: tomamos los IDs y los humanizamos.
        const hints = pendientes.slice(0, 2).map(ev => {
            const id = ev.id.replace(/^llave_[a-z]+_/i, '').replace(/_/g, ' ');
            return id;
        });
        return `${npc.nombre} no ha respondido con información nueva. ` +
               `Reformula tu pregunta. Quedan ${pendientes.length} evidencia${pendientes.length > 1 ? 's' : ''} ` +
               `pendiente${pendientes.length > 1 ? 's' : ''} en líneas de indagación como: ${hints.join(', ')}.`;
    }


    /* ======================================================================
       6 · PANEL DERECHO · Editor del dictamen (6 secciones desde rúbrica)
       ====================================================================== */
    function montarPanelEditor() {
        return el('aside', { class: 'panel panel-editor' },
            el('div', { class: 'panel-header' },
                el('div', { class: 'panel-title' }, 'Dictamen'),
                el('div', { class: 'panel-title-meta', id: 'panel-editor-meta' }, 'Sección 1 / 6')
            ),
            el('div', { class: 'editor-tabs', id: 'editor-tabs' }),
            el('div', { class: 'editor-section-info', id: 'editor-section-info' }),
            el('div', { class: 'editor-canvas' },
                el('textarea', {
                    class: 'editor-textarea',
                    id: 'editor-textarea',
                    placeholder: 'Redacte su análisis profesional...',
                    oninput: onEditorInput,
                    onfocus: () => UI.setEstado('redaccion')
                })
            ),
            el('div', { class: 'editor-foot' },
                el('div', { class: 'editor-foot-status', id: 'editor-status' },
                    el('span', { class: 'save-dot' }),
                    el('span', { id: 'editor-status-text' }, 'Listo')
                ),
                el('button', {
                    class: 'editor-submit-btn',
                    id: 'editor-submit-btn',
                    onclick: enviarDictamen
                }, 'Enviar dictamen →')
            )
        );
    }

    function renderEditor() {
        const secciones = window.Darabia?.Dictamen?.secciones?.() || [];
        if (secciones.length === 0) return;

        // Si no hay sección activa, tomar la primera
        if (!UIState.seccionActiva || !secciones.find(s => s.id === UIState.seccionActiva)) {
            UIState.seccionActiva = secciones[0].id;
        }

        renderEditorTabs(secciones);
        renderEditorContent(secciones);
        actualizarPalabras();
    }

    function renderEditorTabs(secciones) {
        const cont = $('#editor-tabs');
        if (!cont) return;
        cont.innerHTML = '';
        secciones.forEach((sec, idx) => {
            const tieneContenido = (window.Darabia.Dictamen.getSeccion(sec.id) || '').trim().length > 0;
            const activa = sec.id === UIState.seccionActiva;
            const tab = el('button', {
                class: 'editor-tab' + (activa ? ' is-active' : '') + (tieneContenido ? ' has-content' : ''),
                onclick: () => seleccionarSeccion(sec.id)
            },
                el('span', { class: 'tab-num' }, String(idx + 1).padStart(2, '0')),
                sec.etiqueta
            );
            cont.appendChild(tab);
        });

        const idx = secciones.findIndex(s => s.id === UIState.seccionActiva);
        $('#panel-editor-meta').textContent = `Sección ${idx + 1} / ${secciones.length}`;
    }

    function renderEditorContent(secciones) {
        const sec = secciones.find(s => s.id === UIState.seccionActiva);
        if (!sec) return;

        const info = $('#editor-section-info');
        if (info) {
            info.innerHTML = '';
            info.appendChild(document.createTextNode(sec.ayuda || ''));
            info.appendChild(el('span', { class: 'info-weight' }, `Peso ${sec.peso}%`));
        }

        const ta = $('#editor-textarea');
        if (ta) {
            ta.value = window.Darabia.Dictamen.getSeccion(sec.id) || '';
        }
    }

    function seleccionarSeccion(id) {
        // Guardar el contenido actual antes de cambiar
        guardarSeccionActiva();
        UIState.seccionActiva = id;
        renderEditor();
    }

    function guardarSeccionActiva() {
        if (!UIState.seccionActiva) return;
        const ta = $('#editor-textarea');
        if (!ta) return;
        window.Darabia.Dictamen.setSeccion(UIState.seccionActiva, ta.value);
    }

    const onEditorInput = debounce(() => {
        marcarGuardando();
        guardarSeccionActiva();
        actualizarPalabras();
        const secciones = window.Darabia.Dictamen.secciones();
        renderEditorTabs(secciones);
        marcarGuardado();
    }, 600);

    function marcarGuardando() {
        $('#editor-status')?.classList.add('saving');
        $('#editor-status-text')?.replaceChildren(document.createTextNode('Guardando...'));
    }

    function marcarGuardado() {
        clearTimeout(UIState.guardadoTimer);
        UIState.guardadoTimer = setTimeout(() => {
            $('#editor-status')?.classList.remove('saving');
            const ts = new Date();
            const pad = n => n.toString().padStart(2, '0');
            const txt = `Guardado · ${pad(ts.getHours())}:${pad(ts.getMinutes())}`;
            $('#editor-status-text')?.replaceChildren(document.createTextNode(txt));
        }, 250);
    }

    function actualizarPalabras() {
        const total = (window.Darabia.Dictamen.componerTextoCompleto() || '')
            .replace(/##\s+\w[^\n]*/g, '')
            .trim().split(/\s+/).filter(Boolean).length;
        const node = $('#hud-words-value');
        if (node) {
            const old = parseInt(node.textContent, 10) || 0;
            node.textContent = total.toLocaleString('es-ES');
            if (total > old) {
                node.classList.add('is-bumping');
                setTimeout(() => node.classList.remove('is-bumping'), 220);
            }
        }
    }


    /* ======================================================================
       7 · ESTADOS Y TRANSICIONES
       ====================================================================== */
    const UI = {
        setEstado(estado) {
            const validos = ['investigacion', 'redaccion', 'evaluando', 'resultado'];
            if (!validos.includes(estado)) return;
            UIState.estadoActual = estado;
            document.body.classList.remove(
                'estado-investigacion', 'estado-redaccion', 'estado-evaluando', 'estado-resultado');
            document.body.classList.add('estado-' + estado);

            const fase = $('#hud-phase');
            if (fase) {
                const map = {
                    investigacion: 'Investigación',
                    redaccion: 'Redacción',
                    evaluando: 'Evaluando…',
                    resultado: 'Completado'
                };
                fase.innerHTML = '';
                fase.appendChild(document.createTextNode('Fase · '));
                fase.appendChild(el('strong', null, map[estado]));
            }

            // Refuerzo visual del cambio de modo en la cabecera del panel central:
            // - Investigación: verde, "Entrevista"
            // - Redacción:     ámbar, "Registro · entrevistas en pausa"
            const ctxNode = $('#chat-context');
            if (ctxNode) {
                ctxNode.classList.toggle('mode-redaccion', estado === 'redaccion');
            }

            // Sustituir el bloque de input del chat por el bloque de modo redacción.
            renderChatInputArea(estado);
        },

        renderResultado(evaluacion) {
            renderResultadoOverlay(evaluacion);
            UI.setEstado('resultado');
        },

        updateEvidencias() {
            actualizarHUDEvidencias();
            renderPanelIzq();
            const npc = window.Darabia?.caso?.npcs?.find(n => n.id === UIState.npcActivo);
            if (npc) renderChatContext(npc);
        },

        updateChat() {
            renderChatStream();
        },

        render(_fase, _ctx) {
            renderPanelIzq();
            renderEditor();
            actualizarHUDEvidencias();
        }
    };

    function actualizarHUDEvidencias() {
        const npcs = window.Darabia?.caso?.npcs || [];
        const llaves = window.Darabia?.estado?.llaves || {};
        const total = npcs.reduce((acc, n) => acc + (n.evidencias_desbloqueables?.length || 0), 0);
        const ok = Object.keys(llaves).length;
        const node = $('#hud-evid-value');
        if (node) {
            const old = parseInt(node.textContent, 10) || 0;
            node.textContent = `${ok}/${total}`;
            if (ok > old) {
                node.classList.add('is-bumping');
                setTimeout(() => node.classList.remove('is-bumping'), 220);
            }
        }
        const bar = $('#hud-evid-bar');
        if (bar) bar.style.width = total ? ((ok / total) * 100) + '%' : '0%';
    }

    /**
     * Reemplaza el contenido del wrapper del chat-input según el estado.
     * - investigacion: input + botón normal (modo entrevista activo)
     * - redaccion:     bloque honesto "Modo redacción" con CTA de salida
     * - resto:         input deshabilitado pero visible
     */
    function renderChatInputArea(estado) {
        const wrap = $('#chat-input-wrap');
        if (!wrap) return;
        wrap.innerHTML = '';

        if (estado === 'redaccion') {
            wrap.classList.add('is-redaccion');
            wrap.appendChild(el('div', { class: 'redaccion-block' },
                el('div', { class: 'redaccion-icon' }, '✎'),
                el('div', { class: 'redaccion-text' },
                    el('div', { class: 'redaccion-title' }, 'Modo redacción activo'),
                    el('div', { class: 'redaccion-sub' },
                        'Las entrevistas están en pausa mientras redactas el dictamen. ',
                        'Las evidencias siguen visibles arriba como referencia.'
                    )
                ),
                el('button', {
                    class: 'redaccion-back-btn',
                    onclick: () => {
                        UI.setEstado('investigacion');
                        if (UIState.npcActivo) {
                            const input = $('#chat-input');
                            if (input) input.focus();
                        }
                    }
                }, '← Volver a entrevistar')
            ));
            return;
        }

        // Estado investigación (y por defecto)
        wrap.classList.remove('is-redaccion');
        wrap.appendChild(el('div', { class: 'chat-input-row' },
            el('textarea', {
                class: 'chat-input',
                id: 'chat-input',
                rows: '1',
                placeholder: UIState.npcActivo
                    ? 'Formula tu pregunta al técnico...'
                    : 'Selecciona un NPC para iniciar entrevista',
                disabled: UIState.npcActivo ? null : 'disabled',
                oninput: ajustarInput,
                onkeydown: onKeyChat
            }),
            el('button', {
                class: 'chat-send-btn',
                id: 'chat-send-btn',
                disabled: 'disabled',
                onclick: enviarPregunta
            }, 'Preguntar')
        ));
        wrap.appendChild(el('div', { class: 'chat-input-hint' },
            el('span', null, 'Pregunta clara, técnica, breve.'),
            el('span', null, el('kbd', null, '⏎'), ' enviar  ·  ', el('kbd', null, '⇧⏎'), ' salto')
        ));
    }


    /* ======================================================================
       8 · ENVÍO DEL DICTAMEN + ESTADO `evaluando`
       ====================================================================== */
    function montarEvalOverlay() {
        return el('div', { class: 'eval-overlay', id: 'eval-overlay' },
            el('div', { class: 'eval-terminal' },
                el('div', { class: 'eval-terminal-head' },
                    el('div', { class: 'dots' },
                        el('span'), el('span'), el('span')
                    ),
                    el('div', { class: 'label' }, 'darabia-engine · auditoría semántica')
                ),
                el('div', { class: 'eval-terminal-body', id: 'eval-terminal-body' })
            )
        );
    }

    async function enviarDictamen() {
        guardarSeccionActiva();
        const validacion = window.Darabia.Dictamen.validar();
        if (!validacion.valido) {
            const faltan = validacion.secciones_vacias?.join(', ') || 'algunas secciones';
            mostrarToast(
                'Dictamen incompleto',
                `Te faltan secciones por redactar: ${faltan}.`,
                'warning'
            );
            return;
        }

        const submit = $('#editor-submit-btn');
        if (submit) submit.disabled = true;

        UI.setEstado('evaluando');
        // 1. Lanzar terminal narrativo (5 líneas en ~3s, pendiente la sexta)
        iniciarTerminalEval();

        const t0 = Date.now();
        const NARRATIVA_MIN_MS = 3500;       // tiempo mínimo para no romper percepción
        const POST_OK_PAUSE_MS = 800;        // pausa entre OK final y resultado

        try {
            const evaluacion = await window.Darabia.Evaluador.enviar();

            // 2. Esperar a completar la narrativa visual si la API ha sido más rápida
            const transcurrido = Date.now() - t0;
            if (transcurrido < NARRATIVA_MIN_MS) {
                await new Promise(r => setTimeout(r, NARRATIVA_MIN_MS - transcurrido));
            }

            // 3. Mostrar la línea de OK final + pausa estética
            cerrarTerminalEval();
            await new Promise(r => setTimeout(r, POST_OK_PAUSE_MS));

            UI.renderResultado(evaluacion);
        } catch (err) {
            console.error('[UI] Error en evaluación:', err);
            UI.setEstado('redaccion');
            if (submit) submit.disabled = false;

            const msg = err?.codigo === 'LIMITE_CUOTA'
                ? 'El servicio de evaluación ha alcanzado su límite. Inténtalo en unos minutos.'
                : err?.codigo === 'SIN_SALDO'
                    ? 'El servicio de evaluación no está disponible ahora mismo.'
                    : err?.codigo === 'DICTAMEN_INCOMPLETO'
                        ? err.message
                        : 'No se ha podido completar la evaluación. Tu dictamen se ha guardado.';

            mostrarToast('Evaluación interrumpida', msg, 'error');
        }
    }

    /**
     * Inicia el terminal narrativo: 5 líneas con delays escalonados (~3s) que
     * cubren el inicio del proceso. La sexta línea (OK final) se inserta
     * únicamente cuando la API real ha respondido — vía cerrarTerminalEval().
     * Mientras tanto, un cursor parpadeante mantiene la sensación de actividad.
     */
    function iniciarTerminalEval() {
        const body = $('#eval-terminal-body');
        if (!body) return;

        const ts = ahora();
        const lineas = [
            `<span class="ts">[${ts}]</span> Cargando dictamen <span class="arrow">→</span> ${contarPalabrasTotal()} palabras`,
            `<span class="ts">[${ts}]</span> Aplicando rúbrica <span class="arrow">→</span> 6 criterios · 5 ejes longitudinales`,
            `<span class="ts">[${ts}]</span> Triangulando con expediente <span class="arrow">→</span> VA-2026-PSI-047`,
            `<span class="ts">[${ts}]</span> Evaluando vector competencial <span class="arrow">→</span> Karasek · Siegrist · ISTAS21`,
            `<span class="ts">[${ts}]</span> Generando nota de asesoramiento docente <span class="eval-cursor"></span>`
        ];

        body.innerHTML = '';
        lineas.forEach((linea, i) => {
            const div = document.createElement('div');
            div.className = `eval-line delay-${Math.min(i, 5)}`;
            div.innerHTML = linea;
            body.appendChild(div);
        });
    }

    /**
     * Inserta la línea de cierre del terminal cuando la API ha respondido.
     * Reemplaza el cursor parpadeante en la última línea visible y añade el OK.
     */
    function cerrarTerminalEval() {
        const body = $('#eval-terminal-body');
        if (!body) return;
        // Quitar cursor parpadeante de líneas en curso
        const cursores = body.querySelectorAll('.eval-cursor');
        cursores.forEach(c => c.remove());

        const ts = ahora();
        const ok = document.createElement('div');
        ok.className = 'eval-line delay-5';
        ok.innerHTML = `<span class="ts">[${ts}]</span> <span class="ok">✓ Auditoría completada</span>`;
        body.appendChild(ok);
    }

    function contarPalabrasTotal() {
        return (window.Darabia.Dictamen.componerTextoCompleto() || '')
            .replace(/##\s+\w[^\n]*/g, '')
            .trim().split(/\s+/).filter(Boolean).length.toLocaleString('es-ES');
    }


    /* ======================================================================
       9 · ESTADO `resultado` · Overlay con radar + barras + nota docente
       ====================================================================== */
    function montarResultOverlay() {
        return el('div', { class: 'result-overlay', id: 'result-overlay' },
            el('div', { class: 'result-card', id: 'result-card' })
        );
    }

    function renderResultadoOverlay(ev) {
        const card = $('#result-card');
        if (!card) return;
        card.innerHTML = '';

        const nota = ev.nota_global ?? ev.puntuacion_total ?? 0;
        const veredicto = clasificarNota(nota);
        const expediente = window.Darabia.caso?.caso?.id || '—';

        // ─────────── 1. CABECERA · veredicto + perfil técnico (síntesis ejecutiva)
        card.appendChild(el('div', { class: 'result-head' },
            el('div', { class: 'result-expediente' },
                `Expediente · ${expediente}  ·  Auditoría completada`
            ),
            el('div', { class: 'result-veredicto-row' },
                el('div', { class: 'result-veredicto-tag ' + veredicto.tipo }, veredicto.label),
                el('div', { class: 'result-pts' },
                    el('span', { class: 'result-pts-num' }, String(nota)),
                    el('span', { class: 'result-pts-max' }, '/ 100')
                )
            ),
            ev.perfil_tecnico
                ? el('div', { class: 'result-perfil' },
                    el('div', { class: 'result-perfil-label' }, 'Diagnóstico del perfil técnico'),
                    el('div', { class: 'result-perfil-text' }, ev.perfil_tecnico)
                )
                : null
        ));

        // ─────────── 2. ERROR CRÍTICO destacado (si existe, va antes del dashboard)
        if (ev.error_critico) {
            card.appendChild(el('div', { class: 'result-error-banner' },
                el('div', { class: 'result-error-label' }, '⚠ Error crítico que más impacta tu nota'),
                el('div', { class: 'result-error-text' }, ev.error_critico)
            ));
        }

        // ─────────── 3. DASHBOARD · radar + barras
        const body = el('div', { class: 'result-body' });
        body.appendChild(el('div', { class: 'result-col' },
            el('h4', null, 'Vector de competencias (5 ejes)'),
            el('div', { class: 'radar-wrap' }, construirRadar(ev.vector_ejes || []))
        ));
        body.appendChild(el('div', { class: 'result-col' },
            el('h4', null, 'Criterios de la rúbrica'),
            construirBarras(ev.evaluacion_criterios || {})
        ));
        card.appendChild(body);

        // ─────────── 4. FEEDBACK PEDAGÓGICO · qué has hecho bien + qué puedes mejorar
        // (la nota de asesoramiento docente NO se muestra al alumno: vive solo
        //  en el corrector docente, accesible exclusivamente por el profesor)
        const notes = el('div', { class: 'result-notes' });

        if (Array.isArray(ev.que_has_hecho_bien) && ev.que_has_hecho_bien.length) {
            const lista = el('ul', { class: 'note-list' });
            ev.que_has_hecho_bien.forEach(t => lista.appendChild(el('li', null, t)));
            notes.appendChild(el('div', { class: 'note-block' },
                el('div', { class: 'note-label' }, 'Qué has hecho bien'),
                lista
            ));
        }

        if (Array.isArray(ev.que_puedes_mejorar) && ev.que_puedes_mejorar.length) {
            const lista = el('ul', { class: 'note-list' });
            ev.que_puedes_mejorar.forEach(t => lista.appendChild(el('li', null, t)));
            notes.appendChild(el('div', { class: 'note-block is-warning' },
                el('div', { class: 'note-label' }, 'Qué puedes mejorar'),
                lista
            ));
        }

        // Errores clave pedagógicos (si el modelo identifica alguno)
        const erroresClave = ev.errores_clave_pedagogicos || ev.errores_clave;
        if (Array.isArray(erroresClave) && erroresClave.length) {
            const lista = el('ul', { class: 'note-list' });
            erroresClave.forEach(e => lista.appendChild(el('li', null, e)));
            notes.appendChild(el('div', { class: 'note-block is-warning' },
                el('div', { class: 'note-label' }, 'Puntos técnicos a revisar'),
                lista
            ));
        }

        if (notes.children.length > 0) card.appendChild(notes);

        // Aviso final pedagógico: el profesor completará la calificación.
        // Reusa la clase note-block existente para no requerir CSS adicional.
        const aviso = el('div', { class: 'result-notes' },
            el('div', { class: 'note-block', style: 'border-left:2px solid var(--blue);' },
                el('div', { class: 'note-label', style: 'color:var(--blue);' }, 'Sobre tu calificación'),
                el('div', { class: 'note-text' },
                    'Esta evaluación corresponde a la parte automática (60%). ' +
                    'Tu profesor revisará el dictamen y completará la calificación final con la corrección manual (40%).'
                )
            )
        );
        card.appendChild(aviso);

        // ─────────── 5. ACCIONES
        card.appendChild(el('div', { class: 'result-actions' },
            el('button', {
                class: 'btn-action',
                onclick: () => window.print()
            }, 'Imprimir'),
            el('button', {
                class: 'btn-action',
                onclick: () => {
                    document.body.classList.remove('estado-resultado');
                    document.body.classList.add('estado-redaccion');
                    UIState.estadoActual = 'redaccion';
                }
            }, 'Volver al dictamen'),
            el('button', {
                class: 'btn-action primary',
                onclick: () => {
                    if (confirm('¿Iniciar un nuevo peritaje? Se perderá la partida actual.')) {
                        window.Darabia.reiniciar();
                    }
                }
            }, 'Nuevo peritaje')
        ));
    }

    function clasificarNota(n) {
        if (n >= 88) return { label: 'Excelente · Apto con mención', tipo: 'excelente' };
        if (n >= 65) return { label: 'Competente · Apto', tipo: 'competente' };
        if (n >= 50) return { label: 'Suficiente · Apto con observaciones', tipo: 'suficiente' };
        return { label: 'No apto · Reformulación requerida', tipo: 'no-apto' };
    }

    function construirBarras(criterios) {
        const cont = el('div', { class: 'bars-list' });
        const rubrica = window.Darabia?.caso?.aciertos_criticos?.rubrica_evaluacion?.criterios || [];
        rubrica.forEach(c => {
            const valor = criterios[c.id];
            const pts = (typeof valor === 'number') ? valor : 0;
            const max = 10;
            const pct = Math.min(100, (pts / max) * 100);
            const lvl = pts >= 7 ? '' : (pts >= 4 ? 'mid' : 'low');

            cont.appendChild(el('div', { class: 'bar-item' },
                el('div', { class: 'bar-row' },
                    el('div', { class: 'bar-name' }, c.nombre),
                    el('div', { class: 'bar-score' },
                        pts.toFixed(1),
                        el('span', { class: 'max' }, ` / ${max}`)
                    )
                ),
                el('div', { class: 'bar-track' },
                    el('div', { class: 'bar-fill' + (lvl ? ' ' + lvl : ''), style: `width:${pct}%` })
                )
            ));
        });
        return cont;
    }

    /**
     * Radar SVG puro · 5 ejes desde vector_ejes
     */
    function construirRadar(vectorEjes) {
        const NS = 'http://www.w3.org/2000/svg';
        const size = 320;
        const cx = size / 2, cy = size / 2;
        const radio = 110;
        const niveles = 4;
        const labels = vectorEjes.map(v => v.eje);
        const datos = vectorEjes.map(v => Math.max(0, Math.min(1, (v.puntuacion || 0) / (v.max || 10))));
        const N = labels.length || 5;

        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
        svg.setAttribute('xmlns', NS);

        // Niveles concéntricos
        for (let lv = 1; lv <= niveles; lv++) {
            const r = (radio / niveles) * lv;
            const pts = [];
            for (let i = 0; i < N; i++) {
                const ang = (Math.PI * 2 * i) / N - Math.PI / 2;
                pts.push(`${cx + Math.cos(ang) * r},${cy + Math.sin(ang) * r}`);
            }
            const poly = document.createElementNS(NS, 'polygon');
            poly.setAttribute('class', 'radar-grid');
            poly.setAttribute('points', pts.join(' '));
            svg.appendChild(poly);
        }

        // Ejes radiales
        for (let i = 0; i < N; i++) {
            const ang = (Math.PI * 2 * i) / N - Math.PI / 2;
            const x = cx + Math.cos(ang) * radio;
            const y = cy + Math.sin(ang) * radio;
            const line = document.createElementNS(NS, 'line');
            line.setAttribute('x1', cx); line.setAttribute('y1', cy);
            line.setAttribute('x2', x); line.setAttribute('y2', y);
            line.setAttribute('class', 'radar-axis');
            svg.appendChild(line);
        }

        // Área de datos
        const dataPts = [];
        const puntosCirc = [];
        for (let i = 0; i < N; i++) {
            const ang = (Math.PI * 2 * i) / N - Math.PI / 2;
            const r = radio * (datos[i] || 0);
            const x = cx + Math.cos(ang) * r;
            const y = cy + Math.sin(ang) * r;
            dataPts.push(`${x},${y}`);
            puntosCirc.push({ x, y });
        }
        const area = document.createElementNS(NS, 'polygon');
        area.setAttribute('class', 'radar-area');
        area.setAttribute('points', dataPts.join(' '));
        svg.appendChild(area);

        puntosCirc.forEach(p => {
            const c = document.createElementNS(NS, 'circle');
            c.setAttribute('cx', p.x); c.setAttribute('cy', p.y);
            c.setAttribute('r', 3.5);
            c.setAttribute('class', 'radar-point');
            svg.appendChild(c);
        });

        // Labels
        labels.forEach((lab, i) => {
            const ang = (Math.PI * 2 * i) / N - Math.PI / 2;
            const x = cx + Math.cos(ang) * (radio + 22);
            const y = cy + Math.sin(ang) * (radio + 22);
            const t = document.createElementNS(NS, 'text');
            t.setAttribute('x', x);
            t.setAttribute('y', y + 3);
            t.setAttribute('class', 'radar-label');
            t.textContent = abreviarEje(lab);
            svg.appendChild(t);
        });

        return svg;
    }

    function abreviarEje(eje) {
        const m = {
            capacidad_analisis: 'Análisis',
            uso_marcos_teoricos: 'Marcos',
            criterio_intervencion: 'Intervención',
            deteccion_riesgos_criticos: 'Riesgos',
            argumentacion_profesional: 'Argumento'
        };
        return m[eje] || eje.split('_')[0];
    }


    /* ======================================================================
       10 · MODAL EXPEDIENTE LITERAL
       ====================================================================== */
    function montarModal() {
        return el('div', { class: 'modal-backdrop', id: 'modal-backdrop', onclick: cerrarModalSiBackdrop },
            el('div', { class: 'modal' },
                el('div', { class: 'modal-head' },
                    el('div', null,
                        el('div', { class: 'modal-title' }, 'Expediente VA-2026-PSI-047'),
                        el('div', { class: 'modal-sub' }, 'Mutua Prevalia · Aragón · 14 abril 2026')
                    ),
                    el('button', {
                        class: 'modal-close',
                        title: 'Cerrar',
                        onclick: cerrarModal
                    }, '✕')
                ),
                el('div', { class: 'modal-body', id: 'modal-body' })
            )
        );
    }

    function abrirExpediente(seccion) {
        const body = $('#modal-body');
        if (!body) return;
        body.innerHTML = renderExpedienteHTML(seccion);
        $('#modal-backdrop').classList.add('is-open');
        UIState.modalAbierto = true;

        // Scroll a la sección si se pasa identificador
        if (typeof seccion === 'string') {
            const target = body.querySelector(`#sec-${seccion}`);
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    function cerrarModal() {
        $('#modal-backdrop')?.classList.remove('is-open');
        UIState.modalAbierto = false;
    }

    function cerrarModalSiBackdrop(e) {
        if (e.target.id === 'modal-backdrop') cerrarModal();
    }

    /**
     * Contenido literal del expediente — reproducido del HTML original sin
     * reformular. Fuente: expediente_caso05_v3.html
     *
     * REGLA PEDAGÓGICA: las transcripciones de entrevistas SOLO son visibles
     * para los NPCs que el alumno ya ha entrevistado al menos una vez. Esto
     * cierra el atajo de leerse las frases literales de los NPCs antes de
     * formular preguntas. Los datos cuantitativos (fichaje, ISTAS21, contrato,
     * bajas) son visibles desde el inicio: son la base objetiva del trabajo
     * del técnico.
     */
    function renderExpedienteHTML() {
        const entrevistados = UIState.npcsEntrevistados;
        const yaEntrevistadoAna = entrevistados.has('npc_ana');
        const yaEntrevistadoMiguel = entrevistados.has('npc_miguel');
        const yaEntrevistadoSonia = entrevistados.has('npc_sonia');
        const totalEntrevistados = entrevistados.size;

        // Bloque de transcripciones: condicional por NPC
        const bloqueTranscripciones = totalEntrevistados === 0
            ? `
        <section id="sec-transcripciones">
            <h3>9 · Transcripciones · Entrevistas preliminares</h3>
            <div class="doc-meta">Mutua Prevalia · Acceso restringido</div>
            <div class="doc-locked">
                <div class="doc-locked-icon">🔒</div>
                <div class="doc-locked-title">Transcripciones aún no disponibles</div>
                <div class="doc-locked-text">
                    Las transcripciones de las entrevistas preliminares estarán
                    accesibles a medida que tú mismo entrevistes a cada trabajador.
                    Esto refleja el flujo profesional real: las transcripciones se
                    generan a partir del trabajo del técnico, no antes.
                </div>
                <div class="doc-locked-hint">
                    Inicia una entrevista en el panel izquierdo para liberar las transcripciones correspondientes.
                </div>
            </div>
        </section>`
            : `
        <section id="sec-transcripciones">
            <h3>9 · Transcripciones · Entrevistas preliminares</h3>
            <div class="doc-meta">Mutua Prevalia · 08–10 abril 2026 · ${totalEntrevistados}/4 disponibles</div>

            ${yaEntrevistadoAna ? `
            <h4>👩‍💼 Ana Giménez · 08/04/2026 · 16:30h · 34 min</h4>
            <blockquote>"Siento que si me voy a mi hora, el despacho se hunde. Rafael me dice que soy su mano derecha, pero esta mano derecha no duerme más de cuatro horas."</blockquote>
            <blockquote>"El problema no es que haya mucho trabajo en abril. Es que siempre hay mucho trabajo, y siempre soy yo quien lo resuelve. Nadie más sabe cómo van los expedientes de los clientes importantes."</blockquote>
            <blockquote>"Mi madre está sola en casa los martes y los jueves. Yo debería estar con ella a las tres. Llevo tres meses sin poder."</blockquote>
            <p style="font-size:.78rem;color:var(--text-3);"><em>Observación técnica:</em> Mantiene contacto visual sostenido. Interrumpe el discurso en dos ocasiones. Refiere insomnio de mantenimiento desde hace ~3 meses.</p>
            ` : `<div class="doc-locked-mini">Transcripción de Ana Giménez · pendiente de entrevista</div>`}

            ${yaEntrevistadoMiguel ? `
            <h4>👨‍💼 Miguel Santamaría · 09/04/2026 · 10:00h · 21 min</h4>
            <blockquote>"Mi contrato dice auxiliar, pero ayer estuve tres horas limpiando el archivo del sótano y luego fui a por el coche del jefe a la ITV. No sé qué se espera exactamente de mí, y me da miedo preguntar por si no me renuevan en abril."</blockquote>
            <blockquote>"Cada domingo por la noche me entra una angustia que no sé explicar. No sé si el lunes habrá trabajo para mí. Llevo así catorce meses."</blockquote>
            <blockquote>"He empezado a cometer errores que antes no cometía. El otro día tuve que rehacer un modelo tres veces."</blockquote>
            ` : `<div class="doc-locked-mini">Transcripción de Miguel Santamaría · pendiente de entrevista</div>`}

            ${yaEntrevistadoSonia ? `
            <h4>👩‍💻 Sonia Peralta · 10/04/2026 · 09:15h · 12 min · interrumpida por la trabajadora</h4>
            <blockquote>"Yo cumplo mi contrato. Si el resto quiere vivir aquí dentro, es su problema y su decisión."</blockquote>
            <blockquote class="annot">"Rafael ya ni me saluda. Eso tiene un nombre y no es estrés precisamente."</blockquote>
            ` : `<div class="doc-locked-mini">Transcripción de Sonia Peralta · pendiente de entrevista</div>`}
        </section>`;

        return `
        <section id="sec-empresa">
            <h3>1 · Identificación de la empresa</h3>
            <div class="doc-meta">Razón social · CNAE · Domicilio</div>
            <table>
              <tr><th>Razón social</th><td>Gestoría Moreno &amp; Asociados S.L.</td></tr>
              <tr><th>CNAE</th><td>6920 · Actividades de contabilidad</td></tr>
              <tr><th>Domicilio</th><td>C/ Reconquista, 14 · Actur · Zaragoza</td></tr>
              <tr><th>Plantilla</th><td>8 trabajadores</td></tr>
              <tr><th>Fundación</th><td>1987 · Empresa familiar</td></tr>
              <tr><th>Última eval. psicosocial</th><td>2019</td></tr>
            </table>
            <p style="font-size:.82rem;color:var(--text-2);"><em>Instrucción al técnico:</em> Este expediente contiene documentación en bruto extraída de los sistemas de la empresa y de la mutua. No contiene interpretaciones ni diagnósticos. Tu función es analizar cada bloque, extraer evidencias y construir el diagnóstico desde cero.</p>
        </section>

        <section id="sec-fichaje">
            <h3>2 · Registro de control horario · Semana 13–19 abril (punta IVA)</h3>
            <div class="doc-meta">Sistema Factorial HR · Exportación 20/04/2026 · 08:14</div>

            <h4>Ana Giménez Ríos · Indefinido · 40h/semana · Técnico Fiscal</h4>
            <table>
              <tr><td>Lun 13 abr</td><td>08:00 → 20:30</td><td>Pausa comida 20 min (en mesa, pedido a domicilio)</td></tr>
              <tr><td>Mar 14 abr</td><td>08:00 → 21:00</td><td>—</td></tr>
              <tr><td>Mié 15 abr</td><td>07:30 → 20:00</td><td>Llamada cliente 20:12 (fuera de fichaje)</td></tr>
              <tr><td>Jue 16 abr</td><td>08:00 → 20:45</td><td>—</td></tr>
              <tr><td>Vie 17 abr</td><td>08:00 → 19:30</td><td>Sale antes — recoge niño en colegio</td></tr>
            </table>
            <blockquote class="annot">Nota interna del sistema (Rafael Moreno · 18/04): "Ana se ha llevado el portátil a casa el fin de semana para adelantar el modelo 303. Hay que agradecérselo."</blockquote>

            <h4>Miguel Santamaría Vela · Temporal · 30h/semana · Auxiliar Administrativo</h4>
            <table>
              <tr><td>Lun 13 abr</td><td>08:00 → 18:30</td></tr>
              <tr><td>Mar 14 abr</td><td>08:00 → 18:30</td></tr>
              <tr><td>Mié 15 abr</td><td>08:00 → 18:30</td></tr>
              <tr><td>Jue 16 abr</td><td>08:00 → 18:30</td></tr>
              <tr><td>Vie 17 abr</td><td>08:00 → 18:30</td></tr>
            </table>
            <p style="font-size:.78rem;color:var(--text-3)">Jornada contratada: 30h. Jornada real registrada: ~50h. Excedente sin compensar visible.</p>

            <h4>Sonia Peralta Franco · Indefinido · 37,5h/semana · Contable Senior</h4>
            <table>
              <tr><td>Lun 13 abr</td><td>08:00 → 15:00</td></tr>
              <tr><td>Mar 14 abr</td><td>08:00 → 15:00</td></tr>
              <tr><td>Mié 15 abr</td><td>08:00 → 15:00</td></tr>
              <tr><td>Jue 16 abr</td><td>08:00 → 15:00</td></tr>
              <tr><td>Vie 17 abr</td><td>08:00 → 15:00</td></tr>
            </table>
            <blockquote class="annot">Anotación manuscrita de Rafael Moreno (escaneada): "Falta de compromiso flagrante. En plena campaña de IVA se va a su hora como si no fuera con ella."</blockquote>
        </section>

        <section id="sec-bandeja">
            <h3>3 · Bandeja Outlook · Ana Giménez · Lunes 13 abr · 09:47</h3>
            <div class="doc-meta">142 sin leer · 12 llamadas perdidas entre 08:05 y 09:40</div>
            <blockquote>🔴 URGENTE — Error en Modelo 111 enviado ayer (Transportes Ebro) · 08:23<br>
              "Ana, ha llamado el cliente muy enfadado. Dice que el importe no cuadra. Necesito esto resuelto antes de las 11." — Rafael</blockquote>
            <blockquote>RE: RE: RE: Consulta IVA — Cliente muy indignado (Fontanería Casas) · 08:41<br>
              "Llevo tres semanas esperando respuesta. Si no me llamáis hoy, cambio de gestoría."</blockquote>
            <blockquote>⚠ COLEGIO SAGRADA FAMILIA — Tu hijo Marcos · 09:12<br>
              "Buenos días, le escribimos para comunicarle que Marcos no se encuentra bien. Por favor, pase a recogerle o llámenos."</blockquote>
            <blockquote>Ana, mira esto cuando puedas — es para hoy (Rafael) · 09:38<br>
              "He prometido al cliente de Delicias que le tenemos el balance antes de las 17h. Sé que estás liada pero tú eres la única que sabe cómo va ese expediente."</blockquote>
        </section>

        <section id="sec-contrato">
            <h3>4 · Contrato Miguel Santamaría · Renovación nº 4</h3>
            <div class="doc-meta">Art. 15.2 ET · Duración 01/02/2026 – 30/04/2026 · Renovación nº 4</div>
            <p><strong>Cláusula 1ª · Objeto.</strong> Cubrir las necesidades de producción derivadas del incremento de la actividad en el periodo de cierre fiscal trimestral.</p>
            <p><strong>Cláusula 2ª · Jornada.</strong> 30 horas semanales, lunes a viernes, 08:00 a 14:00.</p>
            <blockquote><strong>Cláusula 3ª · Funciones ⚠</strong><br>
              "El trabajador desempeñará las funciones propias de la categoría de Auxiliar Administrativo y aquellas otras que la dirección de la empresa considere necesarias para el buen funcionamiento de la oficina, incluyendo recados externos y apoyo en cualquier departamento."</blockquote>
            <p><strong>Cláusula 4ª · Retribución.</strong> Grupo profesional IV · Convenio Oficinas y Despachos de Aragón · proporcional a jornada.</p>
            <blockquote class="annot">Anotación del expediente (entrevista mutua, 08/04/2026): "Esta semana he llevado el coche de Rafael a la ITV, la semana pasada estuve tres días archivando documentos del 2018 en el sótano. No sé si el mes que viene me renuevan."</blockquote>
        </section>

        <section id="sec-istas">
            <h3>5 · Cuestionario ISTAS21 · Selección de ítems</h3>
            <div class="doc-meta">Aplicación marzo 2026 · Participación 7/8 · 1 declina · n=7</div>
            <table>
              <tr><th>Ítem · Dimensión</th><th>Siempre</th><th>Muchas</th><th>Algunas</th><th>Solo alguna</th><th>Nunca</th></tr>
              <tr><td>1 · ¿Tiene tiempo para terminar su trabajo?</td><td>6</td><td>1</td><td>—</td><td>—</td><td>—</td></tr>
              <tr><td>3 · ¿Tiene que trabajar muy rápido?</td><td>5</td><td>2</td><td>—</td><td>—</td><td>—</td></tr>
              <tr><td>7 · ¿Tiene influencia sobre la cantidad asignada?</td><td>—</td><td>—</td><td>1</td><td>2</td><td>4</td></tr>
              <tr><td>12 · ¿Sabe qué tareas son su responsabilidad?</td><td>—</td><td>1</td><td>3</td><td>2</td><td>1</td></tr>
              <tr><td>15 · ¿Su jefe le ayuda a planificar el trabajo?</td><td>—</td><td>—</td><td>—</td><td>—</td><td><strong>7</strong></td></tr>
              <tr><td>21 · ¿Piensa en exigencias domésticas al trabajar?</td><td>5</td><td>2</td><td>—</td><td>—</td><td>—</td></tr>
              <tr><td>22 · Si falta de casa, ¿tareas domésticas sin hacer?</td><td>4</td><td>3</td><td>—</td><td>—</td><td>—</td></tr>
            </table>
            <p style="font-size:.78rem;color:var(--text-3);"><em>No se incluye interpretación de niveles de riesgo — esa es función del técnico.</em></p>
        </section>

        <section id="sec-bajas">
            <h3>6 · Documentación de incapacidades temporales</h3>
            <div class="doc-meta">Período: may 2025 – abr 2026 · 2 procesos registrados</div>

            <h4>IT-2025-AR-08841 · 04/11/2025 · 14 días</h4>
            <p>Trabajadora · Categoría Senior · Antigüedad &gt; 10 años · CIE-10 <strong>F41.1</strong> (Trastorno de ansiedad generalizada).</p>
            <blockquote>"No puedo dormir. Me despierto a las 3 de la mañana pensando en el trabajo y no consigo volver a dormirme. Tengo una opresión en el pecho que no se me quita. Llevo meses así pero esta semana ya no puedo más."</blockquote>

            <h4>IT-2026-AR-01247 · 17/02/2026 · 21 días</h4>
            <p>Trabajador · Categoría Junior · Antigüedad &lt; 2 años · CIE-10 <strong>F45.1</strong> (Trastorno somatomorfo).</p>
            <p style="font-size:.85rem;color:var(--text-2);">Cefaleas tensionales recurrentes. Dolor cervico-dorsal. Sin patología orgánica.</p>
        </section>

        ${bloqueTranscripciones}
        `;
    }


    /* ======================================================================
       11 · TOASTS
       ====================================================================== */
    function mostrarToast(titulo, cuerpo, tipo = 'success') {
        const host = $('#toast-host');
        if (!host) return;
        const cls = tipo === 'error' ? 'is-error' : (tipo === 'warning' ? 'is-warning' : '');
        const t = el('div', { class: 'toast ' + cls },
            el('div', { class: 'toast-title' }, titulo),
            el('div', { class: 'toast-body' }, cuerpo)
        );
        host.appendChild(t);
        setTimeout(() => {
            t.style.transition = 'opacity 240ms';
            t.style.opacity = '0';
            setTimeout(() => t.remove(), 260);
        }, 4200);
    }


    /* ======================================================================
       12 · BOOT · Pegado al ciclo de vida del motor
       ====================================================================== */
    function boot() {
        if (!window.Darabia) {
            console.error('[UI] window.Darabia no disponible. Carga script_caso05_core.js antes que script_ui.js.');
            return;
        }

        montarShell();

        // Reconstruir estado UI desde el gameState persistido (sesiones recuperadas)
        reconstruirEstadoUI();

        // Renderizado inicial
        UI.render(window.Darabia.estado.fase_actual, {});

        // Conectar el ciclo de render del motor
        window.DarabiaUI = UI;

        // Estado inicial visible: investigación
        UI.setEstado('investigacion');
        actualizarHUDEvidencias();
        actualizarPalabras();

        // Si ya hay un dictamen previo guardado, asegurar que el editor lo refleja
        renderEditor();

        // Atajos de teclado
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (UIState.modalAbierto) cerrarModal();
            }
        });

        console.log('[UI] DarabiaUI montada · estado=' + UIState.estadoActual);
    }

    // Inicialización: si Darabia.iniciar() ya se ha ejecutado externamente,
    // arrancamos en cuanto el DOM esté listo. Si no, esperamos a que el HTML
    // del Paso 4 lo invoque desde su propio inicializador.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            // El boot se llamará desde el HTML tras Darabia.iniciar()
            window.__darabiaUIBoot = boot;
        });
    } else {
        window.__darabiaUIBoot = boot;
    }

})();

/* FIN · script_ui.js */
