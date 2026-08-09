const { sendMessage } = require('../services/whatsapp');
const {
  getClienteByPhone, guardarLid, agregarPendienteSheet,
  getCitas, updateEstadoCita, sumarCancelacion, sumarNoAsistio,
  actualizarUltimoCorte, marcarClienteInactivo, updateCliente,
  normalizarTelefono, agregarCita, resetearCancelaciones,
  setProximoRecordatorio8Dias, borrarCliente,
  getProfesionales, getProfesionalesByTipo,
  getServicios, getServiciosByCategoria, getServicioById,
  getProductos, getProductosByCategoria,
  guardarProfesionalOrigen, guardarProfesionalPreferido,
  getDisponibilidadProfesional
} = require('../services/sheets');
const { getSlotsDisponibles, crearCita, cancelarCita } = require('../services/calendar');
const { getFechaProximoDia, primerNombre } = require('./crons');

const clienteState = {};

const VOLVER_MENU = `\n\n─────────────\nEscribe *menu* para volver al menú 🙌`;
const NUMERO_ASESOR = process.env.NUMERO_ASESOR || '';

function nombreDia(fecha) {
  const d = new Date(fecha + 'T12:00:00-05:00');
  return d.toLocaleDateString('es-CO', { weekday: 'long', timeZone: 'America/Bogota' });
}

async function mostrarMenu(from, nombre) {
  const saludo = primerNombre(nombre) ? `Hola *${primerNombre(nombre)}* 👋` : 'Hola 👋';
  await sendMessage(from,
    `${saludo}, bienvenido a *Saviac Estilo* ✂️\n\nAquí puedes reservar tus servicios desde un solo lugar. ¿Qué te gustaría hacer?\n\n1️⃣ Barbería 💈\n2️⃣ Estilismo 💇\n3️⃣ Manicure / Pedicure 💅\n4️⃣ Productos de belleza 🛍️\n5️⃣ Ver / cambiar mi cita\n6️⃣ Hablar con un asesor\n\n_Responde con el número de tu opción_`
  );
}

async function manejarCliente(from, telefono, body, disponibilidadSemana, msg) {
  const state = clienteState[telefono] || { paso: null };
  let cliente = await getClienteByPhone(telefono);

  if (!cliente && from.includes('@lid') && msg) {
    try {
      const contact = await msg.getContact();
      if (contact.number) {
        const numReal = normalizarTelefono(contact.number);
        cliente = await getClienteByPhone(numReal);
        if (!cliente) {
          const corto = normalizarTelefono(contact.number.slice(-10));
          cliente = await getClienteByPhone(corto);
          if (cliente) telefono = corto;
        } else { telefono = numReal; }
        if (cliente) console.log(`✅ Cliente encontrado: ${cliente.nombre}`);
      }
    } catch (e) { console.log(`⚠️ getContact falló: ${e.message}`); }
  }

  if (from.includes('@lid') && cliente && !cliente.whatsapp_lid) {
    await guardarLid(cliente.rowIndex, from);
  }

  const matchQR = body.match(/código[:\s]+([A-Z]+_\d+)/i);
  if (matchQR) { await manejarRegistroQR(from, telefono, matchQR[1], cliente); return; }

  if (body.toLowerCase() === 'menu') {
    const nombre = cliente ? cliente.nombre : null;
    clienteState[telefono] = { paso: 'menu_principal', nombre };
    await mostrarMenu(from, nombre);
    return;
  }

  if (state.paso === 'menu_principal')                { await manejarMenuPrincipal(from, telefono, body, cliente, disponibilidadSemana); return; }
  if (state.paso === 'eligiendo_servicio')            { await manejarEligiendoServicio(from, telefono, body, state, disponibilidadSemana); return; }
  if (state.paso === 'eligiendo_profesional')         { await manejarEligiendoProfesional(from, telefono, body, state, disponibilidadSemana); return; }
  if (state.paso === 'sin_disponibilidad_prof')       { await manejarSinDisponibilidadProf(from, telefono, body, state, disponibilidadSemana); return; }
  if (state.paso === 'eligiendo_dia')                 { await manejarEligiendoDia(from, telefono, body, state); return; }
  if (state.paso === 'eligiendo_hora')                { await manejarEligiendoHora(from, telefono, body, state); return; }
  if (state.paso === 'confirmando_cita')              { await manejarConfirmandoCita(from, telefono, body, state); return; }
  if (state.paso === 'gestion_cita')                  { await manejarGestionCita(from, telefono, body, state); return; }
  if (state.paso === 'confirmando_cancelacion_final') { await manejarConfirmacionFinalCancelacion(from, telefono, body, state); return; }
  if (state.paso === 'recordatorio_15min')            { await manejarRespuestaRecordatorio(from, telefono, body, state); return; }
  if (state.paso === 'recordatorio_frecuencia')       { await manejarRespuestaFrecuencia(from, telefono, body, state); return; }
  if (state.paso === 'reagendando_por_admin')         { await manejarReagendadoPorAdmin(from, telefono, body, state); return; }
  if (state.paso === 'viendo_productos')              { await manejarProductos(from, telefono, body, state); return; }
  if (state.paso === 'registro_qr_frecuencia')        { await manejarFrecuenciaQR(from, telefono, body, state); return; }
  if (state.paso === 'registro_qr_consentimiento')    { await manejarConsentimientoQR(from, telefono, body, state); return; }
  if (state.paso === 'confirmar_preferido_qr')        { await manejarConfirmarPreferidoQR(from, telefono, body, state); return; }

  if (cliente && cliente.estado === 'inactivo') {
    await sendMessage(from, `😔 Hola *${primerNombre(cliente.nombre)}*! Tu cuenta no está activa.\n\nVisita *Saviac Estilo* para más información. ✂️`);
    return;
  }

  const nombre = cliente ? cliente.nombre : null;
  clienteState[telefono] = { paso: 'menu_principal', nombre };
  await mostrarMenu(from, nombre);
}

// ─── REGISTRO QR ─────────────────────────────────────────
async function manejarRegistroQR(from, telefono, profesionalId, cliente) {
  const profesionales = await getProfesionales();
  const profesional = profesionales.find(p => p.id === profesionalId);
  if (!profesional) { await sendMessage(from, `⚠️ Código QR no reconocido. Escribe *menu* para continuar.`); return; }
  if (cliente) {
    if (!cliente.profesional_origen) await guardarProfesionalOrigen(cliente.rowIndex, profesionalId);
    clienteState[telefono] = { paso: 'confirmar_preferido_qr', profesionalId, nombre: cliente.nombre };
    await sendMessage(from, `👋 ¡Hola *${primerNombre(cliente.nombre)}*! Ya estás registrado.\n\n¿Dejamos a *${profesional.nombre}* como tu profesional preferido?\n\n1) Sí\n2) No`);
    return;
  }
  clienteState[telefono] = { paso: 'registro_qr_frecuencia', profesionalId, profesionalNombre: profesional.nombre };
  await sendMessage(from, `👋 ¡Hola! Bienvenido a *Saviac Estilo*.\n\nLlegaste desde el registro de *${profesional.nombre}*. ¿Me confirmas tu nombre?`);
}

async function manejarConfirmarPreferidoQR(from, telefono, body, state) {
  const cliente = await getClienteByPhone(telefono);
  if (body === '1' && cliente) await guardarProfesionalPreferido(cliente.rowIndex, state.profesionalId);
  clienteState[telefono] = { paso: 'menu_principal', nombre: state.nombre };
  await mostrarMenu(from, state.nombre);
}

async function manejarFrecuenciaQR(from, telefono, body, state) {
  const frecuencias = { '1': '7', '2': '15', '3': '21', '4': '30', '5': 'otro', '6': 'despues' };
  clienteState[telefono] = { ...state, paso: 'registro_qr_consentimiento', frecuencia: frecuencias[body] || 'despues' };
  await sendMessage(from, `¿Deseas activar recordatorios automáticos?\n\n1) Sí\n2) No por ahora`);
}

async function manejarConsentimientoQR(from, telefono, body, state) {
  const profesionales = await getProfesionales();
  const profesional = profesionales.find(p => p.id === state.profesionalId);
  clienteState[telefono] = { paso: 'menu_principal', nombre: state.nombre, profesionalPreferido: state.profesionalId };
  await sendMessage(from, `✅ ¡Listo, *${primerNombre(state.nombre)}*! Registrado con *${profesional?.nombre || 'nuestro profesional'}*.\n\nEscribe *menu* para reservar. ✂️`);
}

// ─── MENÚ PRINCIPAL ──────────────────────────────────────
async function manejarMenuPrincipal(from, telefono, body, cliente, disponibilidadSemana) {
  const nombre = clienteState[telefono]?.nombre || (cliente ? cliente.nombre : null);

  if (body === '1') {
    const servicios = await getServiciosByCategoria('barberia');
    if (!servicios.length) { await sendMessage(from, `😔 No hay servicios disponibles.${VOLVER_MENU}`); return; }
    const lista = servicios.map((s, i) => `${i+1}) ${s.nombre} — $${s.precio.toLocaleString('es-CO')}`).join('\n');
    clienteState[telefono] = { paso: 'eligiendo_servicio', categoria: 'barberia', servicios, nombre };
    await sendMessage(from, `💈 ¿Qué servicio necesitas?\n\n${lista}\n\n_Responde con el número de tu opción_`);
    return;
  }
  if (body === '2') {
    const servicios = await getServiciosByCategoria('estilismo');
    if (!servicios.length) { await sendMessage(from, `😔 No hay servicios disponibles.${VOLVER_MENU}`); return; }
    const lista = servicios.map((s, i) => `${i+1}) ${s.nombre} — $${s.precio.toLocaleString('es-CO')}`).join('\n');
    clienteState[telefono] = { paso: 'eligiendo_servicio', categoria: 'estilismo', servicios, nombre };
    await sendMessage(from, `💇 ¿Qué servicio necesitas?\n\n${lista}\n\n_Responde con el número de tu opción_`);
    return;
  }
  if (body === '3') {
    const servicios = await getServiciosByCategoria('manicure');
    if (!servicios.length) { await sendMessage(from, `😔 No hay servicios disponibles.${VOLVER_MENU}`); return; }
    const lista = servicios.map((s, i) => `${i+1}) ${s.nombre} — $${s.precio.toLocaleString('es-CO')}`).join('\n');
    clienteState[telefono] = { paso: 'eligiendo_servicio', categoria: 'manicure', servicios, nombre };
    await sendMessage(from, `💅 ¿Qué servicio necesitas?\n\n${lista}\n\n_Responde con el número de tu opción_`);
    return;
  }
  if (body === '4') {
    const productos = await getProductos();
    if (!productos.length) { await sendMessage(from, `😔 No hay productos disponibles.${VOLVER_MENU}`); return; }
    const categorias = [...new Set(productos.map(p => p.categoria))];
    const lista = categorias.map((c, i) => `${i+1}) ${c.charAt(0).toUpperCase() + c.slice(1)}`).join('\n');
    clienteState[telefono] = { paso: 'viendo_productos', categorias, productos, nombre };
    await sendMessage(from, `🛍️ ¿Qué tipo de producto buscas?\n\n${lista}\n${categorias.length + 1}) Ver todos\n${categorias.length + 2}) Hablar con asesor\n\n_Responde con el número de tu opción_`);
    return;
  }
  if (body === '5') { await mostrarGestionCita(from, telefono, nombre); return; }
  if (body === '6') {
    clienteState[telefono] = { paso: null, nombre };
    await sendMessage(from, `👤 En breve un asesor de *Saviac Estilo* te contactará. ✂️${VOLVER_MENU}`);
    if (NUMERO_ASESOR) await sendMessage(`${NUMERO_ASESOR}@c.us`, `📢 Cliente *${nombre || telefono}* (${telefono}) solicita asesor.`);
    return;
  }
  await mostrarMenu(from, nombre);
}

// ─── ELIGIENDO SERVICIO ──────────────────────────────────
async function manejarEligiendoServicio(from, telefono, body, state, disponibilidadSemana) {
  const idx = parseInt(body) - 1;
  if (isNaN(idx) || !state.servicios[idx]) {
    const lista = state.servicios.map((s, i) => `${i+1}) ${s.nombre}`).join('\n');
    await sendMessage(from, `⚠️ Opción no válida.\n\n${lista}`); return;
  }

  const servicio = state.servicios[idx];
  const tipoProf = state.categoria === 'barberia' ? 'barbero' : state.categoria === 'estilismo' ? 'estilista' : 'manicurista';
  const profesionales = await getProfesionalesByTipo(tipoProf);

  if (!profesionales.length) { await sendMessage(from, `😔 No hay profesionales disponibles.${VOLVER_MENU}`); return; }

  if (profesionales.length === 1) {
    const dispProf = await getDisponibilidadProfesional(profesionales[0].id);
    clienteState[telefono] = { ...state, paso: 'eligiendo_dia', servicio, profesional: profesionales[0], dispProf };
    await mostrarDiasDisponibles(from, telefono, { ...state, profesional: profesionales[0] }, dispProf);
    return;
  }

  const cliente = await getClienteByPhone(telefono);
  const preferidoId = state.profesionalPreferido || cliente?.profesional_preferido;
  const preferido = preferidoId ? profesionales.find(p => p.id === preferidoId) : null;
  const lista = profesionales.map((p, i) => `${i+1}) ${p.nombre}`).join('\n');
  let msg = `👤 ¿Con quién prefieres tu cita?\n\n${lista}\n${profesionales.length + 1}) Me da igual`;
  if (preferido) msg = `👤 Tu profesional preferido es *${preferido.nombre}*.\n\n¿Con quién prefieres?\n\n${lista}\n${profesionales.length + 1}) Me da igual`;

  clienteState[telefono] = { ...state, paso: 'eligiendo_profesional', servicio, profesionales };
  await sendMessage(from, `${msg}\n\n_Responde con el número de tu opción_`);
}

// ─── ELIGIENDO PROFESIONAL ───────────────────────────────
async function manejarEligiendoProfesional(from, telefono, body, state, disponibilidadSemana) {
  const { profesionales } = state;
  const idx = parseInt(body) - 1;
  const opcionCualquiera = profesionales.length;

  if (idx === opcionCualquiera) {
    for (const prof of profesionales) {
      const disp = await getDisponibilidadProfesional(prof.id);
      if (disp.viernes || disp.sabado || disp.domingo) {
        clienteState[telefono] = { ...state, paso: 'eligiendo_dia', profesional: prof, dispProf: disp };
        await mostrarDiasDisponibles(from, telefono, { ...state, profesional: prof }, disp);
        return;
      }
    }
    await sendMessage(from, `😔 Ningún profesional tiene disponibilidad este fin de semana.\n\nEl próximo jueves te avisamos. ✂️${VOLVER_MENU}`);
    return;
  }

  if (isNaN(idx) || !profesionales[idx]) {
    const lista = profesionales.map((p, i) => `${i+1}) ${p.nombre}`).join('\n');
    await sendMessage(from, `⚠️ Opción no válida.\n\n${lista}\n${opcionCualquiera + 1}) Me da igual`); return;
  }

  const profesional = profesionales[idx];
  const cliente = await getClienteByPhone(telefono);
  if (cliente) await guardarProfesionalPreferido(cliente.rowIndex, profesional.id);

  const dispProf = await getDisponibilidadProfesional(profesional.id);
  console.log(`📅 Disponibilidad ${profesional.nombre}:`, dispProf);

  if (!dispProf.viernes && !dispProf.sabado && !dispProf.domingo) {
    clienteState[telefono] = { ...state, paso: 'sin_disponibilidad_prof', profesional, profesionales };
    await sendMessage(from, `😔 *${profesional.nombre}* no tiene disponibilidad este fin de semana.\n\n¿Deseas elegir otro?\n\n1) Sí\n2) Volver al menú`);
    return;
  }

  clienteState[telefono] = { ...state, paso: 'eligiendo_dia', profesional, dispProf };
  await mostrarDiasDisponibles(from, telefono, { ...state, profesional }, dispProf);
}

// ─── SIN DISPONIBILIDAD ──────────────────────────────────
async function manejarSinDisponibilidadProf(from, telefono, body, state, disponibilidadSemana) {
  if (body === '1') {
    const lista = state.profesionales.map((p, i) => `${i+1}) ${p.nombre}`).join('\n');
    clienteState[telefono] = { ...state, paso: 'eligiendo_profesional' };
    await sendMessage(from, `👤 ¿Con quién prefieres?\n\n${lista}\n${state.profesionales.length + 1}) Me da igual`);
    return;
  }
  clienteState[telefono] = { paso: 'menu_principal', nombre: state.nombre };
  await mostrarMenu(from, state.nombre);
}

// ─── MOSTRAR DÍAS DISPONIBLES ────────────────────────────
async function mostrarDiasDisponibles(from, telefono, state, dispParam) {
  const dias = [];
  if (dispParam?.viernes) dias.push({ label: 'Viernes', fecha: getFechaProximoDia(5) });
  if (dispParam?.sabado)  dias.push({ label: 'Sábado',  fecha: getFechaProximoDia(6) });
  if (dispParam?.domingo) dias.push({ label: 'Domingo', fecha: getFechaProximoDia(0) });

  const calendarId = state.profesional?.calendar_id || null;

  if (!dias.length) {
    await sendMessage(from, `😔 No hay días disponibles este fin de semana.\n\nEl próximo jueves te avisamos. ✂️${VOLVER_MENU}`);
    clienteState[telefono] = { ...state, paso: null }; return;
  }

  if (dias.length === 1) {
    const slots = await getSlotsDisponibles(dias[0].fecha, calendarId);
    if (!slots.length) {
      await sendMessage(from, `😔 No hay horarios disponibles.\n\nEl próximo jueves te avisamos. ✂️${VOLVER_MENU}`);
      clienteState[telefono] = { ...state, paso: null }; return;
    }
    clienteState[telefono] = { ...state, paso: 'eligiendo_hora', dias, dia: dias[0].label, fecha: dias[0].fecha, slots, calendarId };
    const lista = slots.map((s, i) => `${i+1}) ${s}`).join('\n');
    await sendMessage(from, `📅 Horarios para el *${dias[0].label}*:\n\n${lista}\n\n_Responde con el número de tu opción_`);
    return;
  }

  const opciones = dias.map((d, i) => `${i+1}) ${d.label}`).join('\n');
  clienteState[telefono] = { ...state, paso: 'eligiendo_dia', dias, calendarId };
  await sendMessage(from, `📅 ¿Qué día te viene mejor?\n\n${opciones}\n\n_Responde con el número de tu opción_`);
}

// ─── ELIGIENDO DÍA ───────────────────────────────────────
async function manejarEligiendoDia(from, telefono, body, state) {
  const dias = state.dias || [];
  const idx  = parseInt(body) - 1;
  const calendarId = state.calendarId || state.profesional?.calendar_id || null;

  if (isNaN(idx) || !dias[idx]) {
    const opciones = dias.map((d, i) => `${i+1}) ${d.label}`).join('\n');
    await sendMessage(from, `⚠️ Opción no válida.\n\n${opciones}`); return;
  }

  const diaElegido = dias[idx];
  const slots = await getSlotsDisponibles(diaElegido.fecha, calendarId);

  if (!slots.length) {
    const otrosDias = dias.filter((_, i) => i !== idx);
    if (otrosDias.length > 0) {
      const slotsOtro = await getSlotsDisponibles(otrosDias[0].fecha, calendarId);
      if (slotsOtro.length > 0) {
        clienteState[telefono] = { ...state, paso: 'eligiendo_hora', dia: otrosDias[0].label, fecha: otrosDias[0].fecha, slots: slotsOtro, calendarId };
        const lista = slotsOtro.map((s, i) => `${i+1}) ${s}`).join('\n');
        await sendMessage(from, `😔 No hay horarios para el *${diaElegido.label.toLowerCase()}*.\n\n¡El *${otrosDias[0].label.toLowerCase()}* sí tiene! 💈\n\n${lista}\n\n_Responde con el número_`);
        return;
      }
    }
    clienteState[telefono] = { ...state, paso: null };
    await sendMessage(from, `😔 No hay horarios disponibles.\n\nEl próximo jueves te avisamos. ✂️${VOLVER_MENU}`); return;
  }

  clienteState[telefono] = { ...state, paso: 'eligiendo_hora', dia: diaElegido.label, fecha: diaElegido.fecha, slots, calendarId };
  const lista = slots.map((s, i) => `${i+1}) ${s}`).join('\n');
  await sendMessage(from, `📅 Para el *${diaElegido.label}*:\n\n${lista}\n\n_Responde con el número de tu opción_`);
}

// ─── ELIGIENDO HORA ──────────────────────────────────────
async function manejarEligiendoHora(from, telefono, body, state) {
  const idx = parseInt(body) - 1;
  if (isNaN(idx) || !state.slots[idx]) { await sendMessage(from, `⚠️ Opción no válida. Responde con un número de la lista.`); return; }

  const hora       = state.slots[idx];
  const cliente    = await getClienteByPhone(telefono);
  const nombre     = state.nombre || (cliente ? cliente.nombre : 'Cliente');
  const calendarId = state.calendarId || state.profesional?.calendar_id || null;

  let resumen = `📋 *Confirma tu reserva:*\n\n`;
  if (state.servicio)    resumen += `✂️ *Servicio:* ${state.servicio.nombre}\n`;
  if (state.profesional) resumen += `👤 *Profesional:* ${state.profesional.nombre}\n`;
  resumen += `📅 *Día:* ${state.dia}\n⏰ *Hora:* ${hora}\n`;
  if (state.servicio?.precio) resumen += `💰 *Valor:* $${state.servicio.precio.toLocaleString('es-CO')}\n`;
  resumen += `\n1) Confirmar ✅\n2) Cambiar horario\n3) Cancelar proceso`;

  clienteState[telefono] = { ...state, paso: 'confirmando_cita', hora, nombre, calendarId };
  await sendMessage(from, resumen);
}

// ─── CONFIRMANDO CITA ────────────────────────────────────
async function manejarConfirmandoCita(from, telefono, body, state) {
  const calendarId = state.calendarId || state.profesional?.calendar_id || null;

  if (body === '1') {
    const slots = await getSlotsDisponibles(state.fecha, calendarId);
    if (!slots.includes(state.hora)) {
      const lista = slots.map((s, i) => `${i+1}) ${s}`).join('\n');
      clienteState[telefono] = { ...state, paso: 'eligiendo_hora', slots };
      await sendMessage(from, `😔 Ese horario ya no está disponible. Elige otro:\n\n${lista}`); return;
    }

    const cliente = await getClienteByPhone(telefono);
    const nombre  = state.nombre || (cliente ? cliente.nombre : 'Cliente');

    const eventId = await crearCita({
      nombre, telefono,
      fecha: state.fecha,
      hora: state.hora,
      calendarId
    });

    const citaId = await agregarCita({
      telefono, nombre,
      fecha: state.fecha,
      hora: state.hora,
      eventId,
      profesionalId: state.profesional?.id || '',
      servicioId: state.servicio?.id || ''
    });

    clienteState[telefono] = { paso: 'gestion_cita', citaId, nombre };
    await sendMessage(from,
      `🎉 ¡Tu cita quedó confirmada! ✅\n\n${state.servicio ? `✂️ *Servicio:* ${state.servicio.nombre}\n` : ''}${state.profesional ? `👤 *Profesional:* ${state.profesional.nombre}\n` : ''}📅 *${state.dia}*\n⏰ *${state.hora}*\n\n1) Cancelar esta cita\n2) Volver al menú`
    );
    return;
  }

  if (body === '2') {
    const slots = await getSlotsDisponibles(state.fecha, calendarId);
    const lista = slots.map((s, i) => `${i+1}) ${s}`).join('\n');
    clienteState[telefono] = { ...state, paso: 'eligiendo_hora', slots };
    await sendMessage(from, `📅 Elige otro horario:\n\n${lista}`); return;
  }

  if (body === '3') {
    clienteState[telefono] = { paso: 'menu_principal', nombre: state.nombre };
    await mostrarMenu(from, state.nombre); return;
  }

  await sendMessage(from, `⚠️ Responde *1* confirmar, *2* cambiar horario o *3* cancelar.`);
}

// ─── GESTIÓN DE CITA ─────────────────────────────────────
async function mostrarGestionCita(from, telefono, nombre) {
  const citas = await getCitas();
  const fechaViernes = getFechaProximoDia(5);
  const fechaSabado  = getFechaProximoDia(6);
  const fechaDomingo = getFechaProximoDia(0);
  const citaActiva = citas.find(c =>
    c.telefono === telefono &&
    (c.fecha === fechaViernes || c.fecha === fechaSabado || c.fecha === fechaDomingo) &&
    c.estado === 'confirmada'
  );

  if (!citaActiva) {
    clienteState[telefono] = { paso: 'menu_principal', nombre };
    await sendMessage(from, `📅 No tienes ninguna cita agendada para este fin de semana. ✂️${VOLVER_MENU}`); return;
  }

  clienteState[telefono] = { paso: 'gestion_cita', citaId: citaActiva.id, nombre };
  await sendMessage(from,
    `📅 *Tu próxima cita:*\n\n👤 *Nombre:* ${citaActiva.nombre}\n📅 *Día:* ${nombreDia(citaActiva.fecha)}\n⏰ *Hora:* ${citaActiva.hora}\n\n1) Reprogramar\n2) Cancelar\n3) Dejarla igual`
  );
}

async function manejarGestionCita(from, telefono, body, state) {
  if (body === '1') {
    clienteState[telefono] = { ...state, paso: 'eligiendo_dia', reprogramando: true, dias: [] };
    await sendMessage(from, `📅 Vamos a buscar un nuevo horario. Escribe *menu* para cancelar.`); return;
  }
  if (body === '2') {
    clienteState[telefono] = { ...state, paso: 'confirmando_cancelacion_final' };
    await sendMessage(from, `⚠️ ¿Seguro que deseas cancelar?\n\n1) Sí\n2) No, mantener`); return;
  }
  if (body === '3') {
    clienteState[telefono] = { paso: 'menu_principal', nombre: state.nombre };
    await mostrarMenu(from, state.nombre); return;
  }
  await sendMessage(from, `⚠️ Responde *1* reprogramar, *2* cancelar o *3* dejarla igual.`);
}

// ─── PRODUCTOS ───────────────────────────────────────────
async function manejarProductos(from, telefono, body, state) {
  const { categorias, productos, nombre } = state;
  const idx = parseInt(body) - 1;
  const opcionTodos  = categorias.length;
  const opcionAsesor = categorias.length + 1;

  if (idx === opcionAsesor) {
    clienteState[telefono] = { paso: null, nombre };
    await sendMessage(from, `👤 En breve un asesor te atenderá. ✂️${VOLVER_MENU}`); return;
  }

  let productosAMostrar = idx === opcionTodos
    ? productos.filter(p => p.activo)
    : (!isNaN(idx) && categorias[idx]) ? productos.filter(p => p.categoria === categorias[idx] && p.activo) : [];

  if (!productosAMostrar.length) { await sendMessage(from, `😔 No hay productos en esa categoría.${VOLVER_MENU}`); return; }

  let msg = `🛍️ *Productos disponibles:*\n\n`;
  productosAMostrar.forEach((p, i) => { msg += `${i+1}) *${p.nombre}*\n   $${p.precio.toLocaleString('es-CO')} — ${p.descripcion}\n\n`; });
  msg += `Para comprar habla con nuestro asesor.\n\n1) Hablar con asesor\n2) Volver al menú`;

  clienteState[telefono] = { paso: 'menu_principal', nombre };
  await sendMessage(from, msg);
}

// ─── CANCELACIÓN FINAL ───────────────────────────────────
async function manejarConfirmacionFinalCancelacion(from, telefono, body, state) {
  if (body === '1') {
    const citas   = await getCitas();
    const cita    = citas.find(c => c.id === state.citaId);
    const cliente = await getClienteByPhone(telefono);

    if (cita) {
      await updateEstadoCita(cita.rowIndex, 'cancelada');
      if (cita.event_id) await cancelarCita(cita.event_id);
    }

    if (cliente) {
      const nuevasCancelaciones = await sumarCancelacion(cliente.rowIndex, cliente.veces_cancelo);
      if (nuevasCancelaciones >= 3) {
        await borrarCliente(cliente.rowIndex);
        clienteState[telefono] = { paso: null };
        await sendMessage(from, `😔 Cita cancelada. Tu registro fue *eliminado*. Regístrate nuevamente cuando quieras. ✂️`); return;
      }
      if (nuevasCancelaciones === 2) {
        await setProximoRecordatorio8Dias(cliente.rowIndex);
        clienteState[telefono] = { paso: null };
        await sendMessage(from, `😔 Cita cancelada.\n\n⚠️ Segunda cancelación. Una más y tu registro será eliminado.\n\nTe recordaremos en 8 días. ✂️${VOLVER_MENU}`); return;
      }
      await setProximoRecordatorio8Dias(cliente.rowIndex);
    }

    clienteState[telefono] = { paso: null };
    await sendMessage(from, `✅ Cita cancelada. Te recordaremos en 8 días. ✂️${VOLVER_MENU}`);

  } else if (body === '2') {
    clienteState[telefono] = { paso: null };
    await sendMessage(from, `👍 Tu cita sigue activa. ¡Te esperamos! ✂️${VOLVER_MENU}`);
  } else {
    clienteState[telefono] = { paso: 'menu_principal', nombre: state.nombre };
    await mostrarMenu(from, state.nombre);
  }
}

// ─── RECORDATORIO 15 MIN ─────────────────────────────────
async function manejarRespuestaRecordatorio(from, telefono, body, state) {
  const cliente = await getClienteByPhone(telefono);
  const citas   = await getCitas();
  const cita    = citas.find(c => c.id === state.citaId);

  if (body === '1') {
    clienteState[telefono] = { paso: null };
    await sendMessage(from, `✅ ¡Perfecto *${primerNombre(cliente?.nombre)}*! Te esperamos en *Saviac Estilo*. ✂️${VOLVER_MENU}`);
    if (cliente && cita) {
      await updateEstadoCita(cita.rowIndex, 'asistio');
      await resetearCancelaciones(cliente.rowIndex);
      if (cliente.frecuencia) await actualizarUltimoCorte(cliente.rowIndex, cliente.frecuencia);
    }
  } else if (body === '2') {
    if (cita) { await updateEstadoCita(cita.rowIndex, 'cancelada'); if (cita.event_id) await cancelarCita(cita.event_id); }
    if (cliente) {
      const nuevasCancelaciones = await sumarCancelacion(cliente.rowIndex, cliente.veces_cancelo);
      if (nuevasCancelaciones >= 3) { await borrarCliente(cliente.rowIndex); clienteState[telefono] = { paso: null }; await sendMessage(from, `😔 Cita cancelada. Tu registro fue *eliminado*. ✂️`); return; }
      if (nuevasCancelaciones === 2) { await setProximoRecordatorio8Dias(cliente.rowIndex); clienteState[telefono] = { paso: null }; await sendMessage(from, `😔 Cita cancelada.\n\n⚠️ Segunda cancelación. Te recordaremos en 8 días. ✂️${VOLVER_MENU}`); return; }
      await setProximoRecordatorio8Dias(cliente.rowIndex);
    }
    clienteState[telefono] = { paso: null };
    await sendMessage(from, `😔 Cita cancelada. Te recordaremos en 8 días. ✂️${VOLVER_MENU}`);
  } else {
    await sendMessage(from, `⚠️ Responde:\n\n1) Sí, voy en camino 🚀\n2) No puedo ir`);
  }
}

// ─── RECORDATORIO FRECUENCIA ─────────────────────────────
async function manejarRespuestaFrecuencia(from, telefono, body, state) {
  const cliente = await getClienteByPhone(telefono);
  if (body === '1') { clienteState[telefono] = { paso: 'menu_principal', nombre: state.nombre }; await mostrarMenu(from, state.nombre); return; }
  if (body === '2') {
    if (cliente) {
      const n = await sumarCancelacion(cliente.rowIndex, cliente.veces_cancelo);
      if (n >= 3) { await borrarCliente(cliente.rowIndex); clienteState[telefono] = { paso: null }; await sendMessage(from, `😔 Tu registro fue *eliminado*. ✂️`); return; }
      if (n === 2) { await setProximoRecordatorio8Dias(cliente.rowIndex); clienteState[telefono] = { paso: null }; await sendMessage(from, `😔 Entendido.\n\n⚠️ Segunda cancelación. Te recordaremos en 8 días. ✂️`); return; }
      await setProximoRecordatorio8Dias(cliente.rowIndex);
    }
    clienteState[telefono] = { paso: null };
    await sendMessage(from, `😔 Entendido. Te recordaremos en 8 días. ✂️`);
  } else {
    await sendMessage(from, `⚠️ Responde:\n\n1) Sí, quiero agendar\n2) No por ahora`);
  }
}

// ─── REAGENDAR POR ADMIN ─────────────────────────────────
async function manejarReagendadoPorAdmin(from, telefono, body, state) {
  const { diasAlternativos } = state;
  const idx = parseInt(body) - 1;
  const opcionEsperar = diasAlternativos.length;

  if (body === String(opcionEsperar + 1)) { clienteState[telefono] = { paso: null }; await sendMessage(from, `✅ Te contactaremos el próximo jueves. ✂️`); return; }
  if (isNaN(idx) || !diasAlternativos[idx]) {
    const opciones = diasAlternativos.map((d, i) => `${i+1}) ${d.label}`).join('\n');
    await sendMessage(from, `⚠️ Opción no válida.\n\n${opciones}\n${opcionEsperar + 1}) Esperar`); return;
  }

  const diaElegido = diasAlternativos[idx];
  const slots = await getSlotsDisponibles(diaElegido.fecha);
  if (!slots.length) { clienteState[telefono] = { paso: null }; await sendMessage(from, `😔 No hay horarios para ${diaElegido.label}. Te contactaremos el próximo jueves. ✂️`); return; }

  const lista = slots.map((s, i) => `${i+1}) ${s}`).join('\n');
  clienteState[telefono] = { ...state, paso: 'eligiendo_hora', dia: diaElegido.label, fecha: diaElegido.fecha, slots };
  await sendMessage(from, `📅 Horarios para *${diaElegido.label}*:\n\n${lista}`);
}

module.exports = { manejarCliente, clienteState };