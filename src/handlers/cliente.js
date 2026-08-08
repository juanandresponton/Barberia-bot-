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
  guardarProfesionalOrigen, guardarProfesionalPreferido
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

// ─── MENÚ PRINCIPAL ──────────────────────────────────────
async function mostrarMenu(from, nombre) {
  const saludo = primerNombre(nombre) ? `Hola *${primerNombre(nombre)}* 👋` : 'Hola 👋';
  await sendMessage(from,
    `${saludo}, bienvenido a *Saviac Estilo* ✂️\n\nAquí puedes reservar tus servicios desde un solo lugar. ¿Qué te gustaría hacer?\n\n1️⃣ Barbería 💈\n2️⃣ Estilismo 💇\n3️⃣ Manicure / Pedicure 💅\n4️⃣ Productos de belleza 🛍️\n5️⃣ Ver / cambiar mi cita\n6️⃣ Hablar con un asesor\n\n_Responde con el número de tu opción_`
  );
}

// ─── MANEJADOR PRINCIPAL ─────────────────────────────────
async function manejarCliente(from, telefono, body, disponibilidadSemana, msg) {
  const state = clienteState[telefono] || { paso: null };
  let cliente = await getClienteByPhone(telefono);

  // Resolver cliente por getContact si llega como LID
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
        if (cliente) console.log(`✅ Cliente encontrado por getContact: ${cliente.nombre}`);
      }
    } catch (e) { console.log(`⚠️ getContact falló: ${e.message}`); }
  }

  // Guardar LID automáticamente
  if (from.includes('@lid') && cliente && !cliente.whatsapp_lid) {
    await guardarLid(cliente.rowIndex, from);
  }

  // Detectar QR de profesional (mensaje prellenado: "Hola, código: BARB_001")
  const matchQR = body.match(/código[:\s]+([A-Z]+_\d+)/i);
  if (matchQR) {
    await manejarRegistroQR(from, telefono, matchQR[1], cliente, msg);
    return;
  }

  // Comando global: volver al menú
  if (body.toLowerCase() === 'menu') {
    const nombre = cliente ? cliente.nombre : null;
    clienteState[telefono] = { paso: 'menu_principal', nombre };
    await mostrarMenu(from, nombre);
    return;
  }

  // Flujos activos
  if (state.paso === 'menu_principal')              { await manejarMenuPrincipal(from, telefono, body, cliente, disponibilidadSemana); return; }
  if (state.paso === 'eligiendo_categoria')         { await manejarMenuPrincipal(from, telefono, body, cliente, disponibilidadSemana); return; }
  if (state.paso === 'eligiendo_servicio')          { await manejarEligiendoServicio(from, telefono, body, state); return; }
  if (state.paso === 'eligiendo_profesional')       { await manejarEligiendoProfesional(from, telefono, body, state, disponibilidadSemana); return; }
  if (state.paso === 'eligiendo_dia')               { await manejarEligiendoDia(from, telefono, body, state, disponibilidadSemana); return; }
  if (state.paso === 'eligiendo_hora')              { await manejarEligiendoHora(from, telefono, body, state); return; }
  if (state.paso === 'esperando_nombre')            { await manejarNombreNuevo(from, telefono, body, disponibilidadSemana); return; }
  if (state.paso === 'confirmando_cita')            { await manejarConfirmandoCita(from, telefono, body, state); return; }
  if (state.paso === 'gestion_cita')                { await manejarGestionCita(from, telefono, body, state); return; }
  if (state.paso === 'confirmando_cancelacion_final') { await manejarConfirmacionFinalCancelacion(from, telefono, body, state); return; }
  if (state.paso === 'recordatorio_15min')          { await manejarRespuestaRecordatorio(from, telefono, body, state); return; }
  if (state.paso === 'recordatorio_frecuencia')     { await manejarRespuestaFrecuencia(from, telefono, body, state); return; }
  if (state.paso === 'reagendando_por_admin')       { await manejarReagendadoPorAdmin(from, telefono, body, state); return; }
  if (state.paso === 'viendo_productos')            { await manejarProductos(from, telefono, body, state); return; }
  if (state.paso === 'registro_qr_frecuencia')      { await manejarFrecuenciaQR(from, telefono, body, state); return; }
  if (state.paso === 'registro_qr_consentimiento')  { await manejarConsentimientoQR(from, telefono, body, state); return; }

  // Cliente inactivo
  if (cliente && cliente.estado === 'inactivo') {
    await sendMessage(from, `😔 Hola *${primerNombre(cliente.nombre)}*! En este momento tu cuenta no está activa.\n\nVisita *Saviac Estilo* para más información. ✂️`);
    return;
  }

  // Primer mensaje → mostrar menú
  const nombre = cliente ? cliente.nombre : null;
  clienteState[telefono] = { paso: 'menu_principal', nombre };
  await mostrarMenu(from, nombre);
}

// ─── REGISTRO POR QR ─────────────────────────────────────
async function manejarRegistroQR(from, telefono, profesionalId, cliente, msg) {
  const profesionales = await getProfesionales();
  const profesional = profesionales.find(p => p.id === profesionalId);

  if (!profesional) {
    await sendMessage(from, `⚠️ No reconocemos ese código QR. Por favor escribe *menu* para ver nuestras opciones.`);
    return;
  }

  // Si el cliente ya existe, actualizar relación con profesional
  if (cliente) {
    if (!cliente.profesional_origen) {
      await guardarProfesionalOrigen(cliente.rowIndex, profesionalId);
    }
    await guardarProfesionalPreferido(cliente.rowIndex, profesionalId);

    clienteState[telefono] = { paso: 'menu_principal', nombre: cliente.nombre, profesionalPreferido: profesionalId };
    await sendMessage(from,
      `👋 ¡Hola *${primerNombre(cliente.nombre)}*! Ya te tenemos registrado.\n\nTe hemos asociado con *${profesional.nombre}* como tu profesional de referencia.\n\n¿Deseas dejarlo como tu profesional preferido para este servicio?\n\n1) Sí, dejar como preferido\n2) No, mantener el anterior\n\n_Responde con el número de tu opción_`
    );
    clienteState[telefono] = { paso: 'confirmar_preferido_qr', profesionalId, nombre: cliente.nombre };
    return;
  }

  // Cliente nuevo desde QR
  clienteState[telefono] = { paso: 'esperando_nombre_qr', profesionalId, profesionalNombre: profesional.nombre };
  await sendMessage(from,
    `👋 ¡Hola! Bienvenido a *Saviac Estilo*.\n\nVeo que llegaste desde el registro de *${profesional.nombre}*. Para guardar tu visita y poder recordarte tu próxima cita, ¿me confirmas tu nombre?`
  );
}

async function manejarNombreQR(from, telefono, body, state) {
  const nombre = body;
  clienteState[telefono] = { ...state, paso: 'registro_qr_frecuencia', nombre };

  await sendMessage(from,
    `¡Gracias, *${primerNombre(nombre)}*! ¿Cada cuánto sueles realizarte este servicio?\n\n1) Cada 7 días\n2) Cada 15 días\n3) Cada 21 días\n4) Cada 30 días\n5) Otro\n6) Prefiero definirlo después\n\n_Responde con el número de tu opción_`
  );
}

async function manejarFrecuenciaQR(from, telefono, body, state) {
  const frecuencias = { '1': '7', '2': '15', '3': '21', '4': '30', '5': 'otro', '6': 'despues' };
  const frecuencia = frecuencias[body] || 'despues';

  clienteState[telefono] = { ...state, paso: 'registro_qr_consentimiento', frecuencia };
  await sendMessage(from,
    `Perfecto. Podemos enviarte un recordatorio cuando se acerque tu próxima fecha para que elijas un horario disponible.\n\n¿Deseas activar estos recordatorios?\n\n1) Sí, activar\n2) No por ahora\n\n_Responde con el número de tu opción_`
  );
}

async function manejarConsentimientoQR(from, telefono, body, state) {
  const consentimiento = body === '1';
  const profesionales = await getProfesionales();
  const profesional = profesionales.find(p => p.id === state.profesionalId);

  // Aquí normalmente crearíamos el cliente en el Sheet
  // Por ahora guardamos en state y mostramos cierre
  clienteState[telefono] = { paso: 'menu_principal', nombre: state.nombre, profesionalPreferido: state.profesionalId };

  await sendMessage(from,
    `✅ ¡Listo, *${primerNombre(state.nombre)}*! Quedaste registrado con *${profesional?.nombre || 'nuestro profesional'}* como tu profesional de referencia.\n\nCuando quieras reservar, escribe *CITA* o *menu* a este mismo número. ✂️`
  );
}

// ─── MENÚ PRINCIPAL ──────────────────────────────────────
async function manejarMenuPrincipal(from, telefono, body, cliente, disponibilidadSemana) {
  const nombre = clienteState[telefono]?.nombre || (cliente ? cliente.nombre : null);

  // 1 - Barbería
  if (body === '1') {
    const servicios = await getServiciosByCategoria('barberia');
    if (servicios.length === 0) {
      await sendMessage(from, `😔 No hay servicios disponibles por ahora.${VOLVER_MENU}`);
      return;
    }
    const lista = servicios.map((s, i) => `${i+1}) ${s.nombre} — $${s.precio.toLocaleString('es-CO')}`).join('\n');
    clienteState[telefono] = { paso: 'eligiendo_servicio', categoria: 'barberia', servicios, nombre };
    await sendMessage(from, `💈 ¡Perfecto! ¿Qué servicio necesitas?\n\n${lista}\n\n_Responde con el número de tu opción_`);
    return;
  }

  // 2 - Estilismo
  if (body === '2') {
    const servicios = await getServiciosByCategoria('estilismo');
    if (servicios.length === 0) {
      await sendMessage(from, `😔 No hay servicios disponibles por ahora.${VOLVER_MENU}`);
      return;
    }
    const lista = servicios.map((s, i) => `${i+1}) ${s.nombre} — $${s.precio.toLocaleString('es-CO')}`).join('\n');
    clienteState[telefono] = { paso: 'eligiendo_servicio', categoria: 'estilismo', servicios, nombre };
    await sendMessage(from, `💇 ¡Perfecto! ¿Qué servicio necesitas?\n\n${lista}\n\n_Responde con el número de tu opción_`);
    return;
  }

  // 3 - Manicure
  if (body === '3') {
    const servicios = await getServiciosByCategoria('manicure');
    if (servicios.length === 0) {
      await sendMessage(from, `😔 No hay servicios disponibles por ahora.${VOLVER_MENU}`);
      return;
    }
    const lista = servicios.map((s, i) => `${i+1}) ${s.nombre} — $${s.precio.toLocaleString('es-CO')}`).join('\n');
    clienteState[telefono] = { paso: 'eligiendo_servicio', categoria: 'manicure', servicios, nombre };
    await sendMessage(from, `💅 ¡Perfecto! ¿Qué servicio necesitas?\n\n${lista}\n\n_Responde con el número de tu opción_`);
    return;
  }

  // 4 - Productos
  if (body === '4') {
    const productos = await getProductos();
    if (productos.length === 0) {
      await sendMessage(from, `😔 No hay productos disponibles por ahora.${VOLVER_MENU}`);
      return;
    }
    const categorias = [...new Set(productos.map(p => p.categoria))];
    const lista = categorias.map((c, i) => `${i+1}) ${c.charAt(0).toUpperCase() + c.slice(1)}`).join('\n');
    clienteState[telefono] = { paso: 'viendo_productos', categorias, productos, nombre };
    await sendMessage(from, `🛍️ ¿Qué tipo de producto estás buscando?\n\n${lista}\n${categorias.length + 1}) Ver todos\n${categorias.length + 2}) Hablar con un asesor\n\n_Responde con el número de tu opción_`);
    return;
  }

  // 5 - Ver/cambiar cita
  if (body === '5') {
    await mostrarGestionCita(from, telefono, nombre);
    return;
  }

  // 6 - Hablar con asesor
  if (body === '6') {
    clienteState[telefono] = { paso: null, nombre, handoff: true };
    await sendMessage(from,
      `👤 Entendido. En breve un asesor de *Saviac Estilo* se pondrá en contacto contigo.\n\nSi necesitas continuar usando el bot, escribe *menu* en cualquier momento. ✂️`
    );
    if (NUMERO_ASESOR) {
      await sendMessage(`${NUMERO_ASESOR}@c.us`,
        `📢 Cliente *${nombre || telefono}* (${telefono}) solicita atención de asesor en Saviac Estilo.`
      );
    }
    return;
  }

  // Opción inválida
  await mostrarMenu(from, nombre);
}

// ─── ELIGIENDO SERVICIO ──────────────────────────────────
async function manejarEligiendoServicio(from, telefono, body, state) {
  const idx = parseInt(body) - 1;
  if (isNaN(idx) || !state.servicios[idx]) {
    const lista = state.servicios.map((s, i) => `${i+1}) ${s.nombre}`).join('\n');
    await sendMessage(from, `⚠️ Opción no válida.\n\n${lista}`);
    return;
  }

  const servicio = state.servicios[idx];
  const profesionales = await getProfesionalesByTipo(state.categoria === 'barberia' ? 'barbero' : state.categoria === 'estilismo' ? 'estilista' : 'manicurista');

  if (profesionales.length === 0) {
    await sendMessage(from, `😔 No hay profesionales disponibles por ahora.${VOLVER_MENU}`);
    return;
  }

  // Si solo hay un profesional, seleccionarlo automáticamente
  if (profesionales.length === 1) {
    clienteState[telefono] = { ...state, paso: 'eligiendo_dia', servicio, profesional: profesionales[0], dias: [] };
    await mostrarDiasDisponibles(from, telefono, state);
    return;
  }

  // Verificar si tiene profesional preferido
  const cliente = await getClienteByPhone(telefono);
  const preferidoId = state.profesionalPreferido || cliente?.profesional_preferido;
  const preferido = preferidoId ? profesionales.find(p => p.id === preferidoId) : null;

  const lista = profesionales.map((p, i) => `${i+1}) ${p.nombre}`).join('\n');
  const opciones = `${lista}\n${profesionales.length + 1}) Me da igual, quiero el primer cupo disponible`;

  clienteState[telefono] = { ...state, paso: 'eligiendo_profesional', servicio, profesionales };

  let msg = `👤 ¿Con quién prefieres tu cita?\n\n${opciones}`;
  if (preferido) msg = `👤 Tu profesional preferido es *${preferido.nombre}*.\n\n¿Con quién prefieres tu cita?\n\n${opciones}`;

  await sendMessage(from, `${msg}\n\n_Responde con el número de tu opción_`);
}

// ─── ELIGIENDO PROFESIONAL ───────────────────────────────
async function manejarEligiendoProfesional(from, telefono, body, state, disponibilidadSemana) {
  const { profesionales } = state;
  const idx = parseInt(body) - 1;
  const opcionCualquiera = profesionales.length;

  // Primer cupo disponible
  if (idx === opcionCualquiera) {
    clienteState[telefono] = { ...state, paso: 'eligiendo_dia', profesional: null };
    await mostrarDiasDisponibles(from, telefono, { ...state, profesional: null }, disponibilidadSemana);
    return;
  }

  if (isNaN(idx) || !profesionales[idx]) {
    const lista = profesionales.map((p, i) => `${i+1}) ${p.nombre}`).join('\n');
    await sendMessage(from, `⚠️ Opción no válida.\n\n${lista}\n${opcionCualquiera + 1}) Me da igual`);
    return;
  }

  const profesional = profesionales[idx];
  clienteState[telefono] = { ...state, paso: 'eligiendo_dia', profesional };

  // Guardar como preferido
  const cliente = await getClienteByPhone(telefono);
  if (cliente) await guardarProfesionalPreferido(cliente.rowIndex, profesional.id);

  await mostrarDiasDisponibles(from, telefono, { ...state, profesional }, disponibilidadSemana);
}

// ─── MOSTRAR DÍAS DISPONIBLES ────────────────────────────
async function mostrarDiasDisponibles(from, telefono, state, disponibilidadSemana) {
  const dias = [];
  if (disponibilidadSemana?.viernes) dias.push({ label: 'Viernes', fecha: getFechaProximoDia(5) });
  if (disponibilidadSemana?.sabado)  dias.push({ label: 'Sábado',  fecha: getFechaProximoDia(6) });
  if (disponibilidadSemana?.domingo) dias.push({ label: 'Domingo', fecha: getFechaProximoDia(0) });

  if (dias.length === 0) {
    await sendMessage(from, `😔 No hay días disponibles este fin de semana.\n\nEl próximo jueves te avisamos. ✂️${VOLVER_MENU}`);
    return;
  }

  if (dias.length === 1) {
    const slots = await getSlotsDisponibles(dias[0].fecha);
    if (slots.length === 0) {
      await sendMessage(from, `😔 No hay horarios disponibles.\n\nEl próximo jueves te avisamos. ✂️${VOLVER_MENU}`);
      return;
    }
    clienteState[telefono] = { ...state, paso: 'eligiendo_hora', dias, dia: dias[0].label, fecha: dias[0].fecha, slots };
    const lista = slots.map((s, i) => `${i+1}) ${s}`).join('\n');
    await sendMessage(from, `📅 ¡Perfecto! Horarios disponibles para el *${dias[0].label}*:\n\n${lista}\n\n_Responde con el número de tu opción_`);
    return;
  }

  const opciones = dias.map((d, i) => `${i+1}) ${d.label}`).join('\n');
  clienteState[telefono] = { ...state, paso: 'eligiendo_dia', dias };
  await sendMessage(from, `📅 ¿Qué día te viene mejor?\n\n${opciones}\n\n_Responde con el número de tu opción_`);
}

// ─── ELIGIENDO DÍA ───────────────────────────────────────
async function manejarEligiendoDia(from, telefono, body, state, disponibilidadSemana) {
  const dias = state.dias || [];
  const idx  = parseInt(body) - 1;

  if (isNaN(idx) || !dias[idx]) {
    const opciones = dias.map((d, i) => `${i+1}) ${d.label}`).join('\n');
    await sendMessage(from, `⚠️ Opción no válida.\n\n${opciones}`);
    return;
  }

  const diaElegido = dias[idx];
  const slots = await getSlotsDisponibles(diaElegido.fecha);

  if (slots.length === 0) {
    const otrosDias = dias.filter((_, i) => i !== idx);
    if (otrosDias.length > 0) {
      const slotsOtro = await getSlotsDisponibles(otrosDias[0].fecha);
      if (slotsOtro.length > 0) {
        clienteState[telefono] = { ...state, paso: 'eligiendo_hora', dia: otrosDias[0].label, fecha: otrosDias[0].fecha, slots: slotsOtro };
        const lista = slotsOtro.map((s, i) => `${i+1}) ${s}`).join('\n');
        await sendMessage(from, `😔 No hay horarios para el *${diaElegido.label.toLowerCase()}*.\n\n¡Pero el *${otrosDias[0].label.toLowerCase()}* sí tenemos espacio! 💈\n\n${lista}\n\n_Responde con el número de tu opción_`);
        return;
      }
    }
    clienteState[telefono] = { ...state, paso: null };
    await sendMessage(from, `😔 No hay horarios disponibles.\n\nEl próximo jueves te avisamos. ✂️${VOLVER_MENU}`);
    return;
  }

  clienteState[telefono] = { ...state, paso: 'eligiendo_hora', dia: diaElegido.label, fecha: diaElegido.fecha, slots };
  const lista = slots.map((s, i) => `${i+1}) ${s}`).join('\n');
  await sendMessage(from, `📅 ¡Perfecto! Para el *${diaElegido.label}* tenemos estos horarios:\n\n${lista}\n\n_Responde con el número de tu opción_`);
}

// ─── ELIGIENDO HORA ──────────────────────────────────────
async function manejarEligiendoHora(from, telefono, body, state) {
  const idx = parseInt(body) - 1;
  if (isNaN(idx) || !state.slots[idx]) {
    await sendMessage(from, `⚠️ Opción no válida. Por favor responde con un número de la lista.`);
    return;
  }

  const hora     = state.slots[idx];
  const cliente  = await getClienteByPhone(telefono);
  const nombre   = state.nombre || (cliente ? cliente.nombre : 'Cliente');
  const servicio = state.servicio;
  const profesional = state.profesional;

  // Mostrar confirmación antes de guardar
  let resumen = `📋 *Confirma tu reserva:*\n\n`;
  if (servicio) resumen += `✂️ *Servicio:* ${servicio.nombre}\n`;
  if (profesional) resumen += `👤 *Profesional:* ${profesional.nombre}\n`;
  resumen += `📅 *Día:* ${state.dia}\n`;
  resumen += `⏰ *Hora:* ${hora}\n`;
  if (servicio?.precio) resumen += `💰 *Valor:* $${servicio.precio.toLocaleString('es-CO')}\n`;
  resumen += `\n1) Confirmar cita ✅\n2) Cambiar horario\n3) Cancelar proceso`;

  clienteState[telefono] = { ...state, paso: 'confirmando_cita', hora, nombre };
  await sendMessage(from, resumen);
}

// ─── CONFIRMANDO CITA ────────────────────────────────────
async function manejarConfirmandoCita(from, telefono, body, state) {
  if (body === '1') {
    // Revalidar slot antes de confirmar
    const slots = await getSlotsDisponibles(state.fecha);
    if (!slots.includes(state.hora)) {
      await sendMessage(from, `😔 Lo sentimos, ese horario ya no está disponible. Por favor elige otro.`);
      const lista = slots.map((s, i) => `${i+1}) ${s}`).join('\n');
      clienteState[telefono] = { ...state, paso: 'eligiendo_hora', slots };
      await sendMessage(from, `📅 Horarios disponibles:\n\n${lista}\n\n_Responde con el número de tu opción_`);
      return;
    }

    const cliente = await getClienteByPhone(telefono);
    const nombre  = state.nombre || (cliente ? cliente.nombre : 'Cliente');

    const eventId = await crearCita({ nombre, telefono, fecha: state.fecha, hora: state.hora });
    const citaId  = await agregarCita({
      telefono, nombre,
      fecha: state.fecha,
      hora: state.hora,
      eventId,
      profesionalId: state.profesional?.id || '',
      servicioId: state.servicio?.id || ''
    });

    clienteState[telefono] = { paso: 'gestion_cita', citaId, nombre };
    await sendMessage(from,
      `🎉 ¡Tu cita quedó confirmada! ✅\n\n${state.servicio ? `✂️ *Servicio:* ${state.servicio.nombre}\n` : ''}${state.profesional ? `👤 *Profesional:* ${state.profesional.nombre}\n` : ''}📅 *${state.dia}*\n⏰ *${state.hora}*\n\nSi necesitas cambiarla, escribe *CAMBIAR CITA* o selecciona una opción:\n\n1) Cancelar esta cita\n2) Volver al menú`
    );
    console.log(`✅ Cita confirmada: ${nombre} | ${state.fecha} | ${state.hora}`);
    return;
  }

  if (body === '2') {
    // Cambiar horario
    const slots = await getSlotsDisponibles(state.fecha);
    const lista = slots.map((s, i) => `${i+1}) ${s}`).join('\n');
    clienteState[telefono] = { ...state, paso: 'eligiendo_hora', slots };
    await sendMessage(from, `📅 Elige otro horario:\n\n${lista}\n\n_Responde con el número de tu opción_`);
    return;
  }

  if (body === '3') {
    clienteState[telefono] = { paso: 'menu_principal', nombre: state.nombre };
    await mostrarMenu(from, state.nombre);
    return;
  }

  await sendMessage(from, `⚠️ Responde *1* para confirmar, *2* para cambiar horario o *3* para cancelar.`);
}

// ─── GESTIÓN DE CITA (VER/CAMBIAR/CANCELAR) ─────────────
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
    await sendMessage(from, `📅 No tienes ninguna cita agendada para este fin de semana. ✂️${VOLVER_MENU}`);
    return;
  }

  clienteState[telefono] = { paso: 'gestion_cita', citaId: citaActiva.id, nombre };
  await sendMessage(from,
    `📅 *Tu próxima cita:*\n\n👤 *Nombre:* ${citaActiva.nombre}\n📅 *Día:* ${nombreDia(citaActiva.fecha)}\n⏰ *Hora:* ${citaActiva.hora}\n\n¿Qué deseas hacer?\n\n1) Reprogramar\n2) Cancelar\n3) Dejarla igual\n\n_Responde con el número de tu opción_`
  );
}

async function manejarGestionCita(from, telefono, body, state) {
  const nombre = state.nombre;

  if (body === '1') {
    // Reprogramar — mostrar días disponibles
    clienteState[telefono] = { ...state, paso: 'eligiendo_dia', reprogramando: true, dias: [] };
    await sendMessage(from, `📅 Vamos a buscar un nuevo horario. Escribe *menu* si deseas cancelar este proceso.`);
    return;
  }

  if (body === '2') {
    // Cancelar
    clienteState[telefono] = { ...state, paso: 'confirmando_cancelacion_final' };
    await sendMessage(from,
      `⚠️ ¿Seguro que deseas cancelar tu cita?\n\n1) Sí, cancelar definitivamente\n2) No, mantener mi cita\n\n_Responde con el número de tu opción_`
    );
    return;
  }

  if (body === '3') {
    clienteState[telefono] = { paso: 'menu_principal', nombre };
    await mostrarMenu(from, nombre);
    return;
  }

  await sendMessage(from, `⚠️ Responde *1* para reprogramar, *2* para cancelar o *3* para dejarla igual.`);
}

// ─── PRODUCTOS ───────────────────────────────────────────
async function manejarProductos(from, telefono, body, state) {
  const { categorias, productos, nombre } = state;
  const idx = parseInt(body) - 1;
  const opcionTodos   = categorias.length;
  const opcionAsesor  = categorias.length + 1;

  if (idx === opcionAsesor) {
    clienteState[telefono] = { paso: null, nombre, handoff: true };
    await sendMessage(from, `👤 En breve un asesor te atenderá para ayudarte con los productos. ✂️${VOLVER_MENU}`);
    return;
  }

  let productosAMostrar = [];
  if (idx === opcionTodos) {
    productosAMostrar = productos.filter(p => p.activo);
  } else if (!isNaN(idx) && categorias[idx]) {
    productosAMostrar = productos.filter(p => p.categoria === categorias[idx] && p.activo);
  } else {
    const lista = categorias.map((c, i) => `${i+1}) ${c.charAt(0).toUpperCase() + c.slice(1)}`).join('\n');
    await sendMessage(from, `⚠️ Opción no válida.\n\n${lista}\n${opcionTodos + 1}) Ver todos\n${opcionAsesor + 1}) Hablar con asesor`);
    return;
  }

  if (productosAMostrar.length === 0) {
    await sendMessage(from, `😔 No hay productos disponibles en esa categoría.${VOLVER_MENU}`);
    return;
  }

  let msg = `🛍️ *Productos disponibles:*\n\n`;
  productosAMostrar.forEach((p, i) => {
    msg += `${i+1}) *${p.nombre}*\n   $${p.precio.toLocaleString('es-CO')} — ${p.descripcion}\n\n`;
  });
  msg += `Para comprar alguno, habla con nuestro asesor.\n\n1) Hablar con asesor\n2) Volver al menú`;

  clienteState[telefono] = { paso: 'menu_principal', nombre };
  await sendMessage(from, msg);
}

// ─── CANCELACIÓN FINAL ───────────────────────────────────
async function manejarConfirmacionFinalCancelacion(from, telefono, body, state) {
  if (body === '1') {
    const citas  = await getCitas();
    const cita   = citas.find(c => c.id === state.citaId);
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
        await sendMessage(from, `😔 Tu cita fue cancelada.\n\nDebido a cancelaciones repetidas tu registro ha sido *eliminado* de la base de datos de *Saviac Estilo*.\n\nSi deseas volver, regístrate nuevamente. ✂️`);
        return;
      }
      if (nuevasCancelaciones === 2) {
        await setProximoRecordatorio8Dias(cliente.rowIndex);
        clienteState[telefono] = { paso: null };
        await sendMessage(from, `😔 Tu cita fue cancelada.\n\n⚠️ *Atención:* Esta es tu segunda cancelación. Si cancelas una vez más, tu registro será eliminado.\n\nTe recordaremos en 8 días. ✂️${VOLVER_MENU}`);
        return;
      }
      await setProximoRecordatorio8Dias(cliente.rowIndex);
    }

    clienteState[telefono] = { paso: null };
    await sendMessage(from, `✅ Tu cita fue cancelada. Te recordaremos en 8 días. ✂️${VOLVER_MENU}`);

  } else if (body === '2') {
    clienteState[telefono] = { paso: null };
    await sendMessage(from, `👍 ¡Perfecto! Tu cita sigue activa. ¡Te esperamos! ✂️${VOLVER_MENU}`);
  } else {
    clienteState[telefono] = { paso: 'menu_principal', nombre: state.nombre };
    await mostrarMenu(from, state.nombre);
  }
}

// ─── RESPUESTA RECORDATORIO 15 MIN ───────────────────────
async function manejarRespuestaRecordatorio(from, telefono, body, state) {
  const cliente = await getClienteByPhone(telefono);
  const citas   = await getCitas();
  const cita    = citas.find(c => c.id === state.citaId);

  if (body === '1') {
    clienteState[telefono] = { paso: null };
    await sendMessage(from, `✅ ¡Perfecto *${primerNombre(cliente?.nombre)}*! Te esperamos en *Saviac Estilo*. Hasta pronto ✂️${VOLVER_MENU}`);
    if (cliente && cita) {
      await updateEstadoCita(cita.rowIndex, 'asistio');
      await resetearCancelaciones(cliente.rowIndex);
      if (cliente.frecuencia) await actualizarUltimoCorte(cliente.rowIndex, cliente.frecuencia);
    }
  } else if (body === '2') {
    if (cita) { await updateEstadoCita(cita.rowIndex, 'cancelada'); if (cita.event_id) await cancelarCita(cita.event_id); }
    if (cliente) {
      const nuevasCancelaciones = await sumarCancelacion(cliente.rowIndex, cliente.veces_cancelo);
      if (nuevasCancelaciones >= 3) {
        await borrarCliente(cliente.rowIndex);
        clienteState[telefono] = { paso: null };
        await sendMessage(from, `😔 Tu cita fue cancelada.\n\nDebido a cancelaciones repetidas tu registro ha sido *eliminado*. Si deseas volver, regístrate nuevamente. ✂️`);
        return;
      }
      if (nuevasCancelaciones === 2) {
        await setProximoRecordatorio8Dias(cliente.rowIndex);
        clienteState[telefono] = { paso: null };
        await sendMessage(from, `😔 Cita cancelada.\n\n⚠️ Esta es tu segunda cancelación. Si cancelas una vez más, tu registro será eliminado.\n\nTe recordaremos en 8 días. ✂️${VOLVER_MENU}`);
        return;
      }
      await setProximoRecordatorio8Dias(cliente.rowIndex);
    }
    clienteState[telefono] = { paso: null };
    await sendMessage(from, `😔 Cita cancelada. Te recordaremos en 8 días. ✂️${VOLVER_MENU}`);
  } else {
    await sendMessage(from, `⚠️ Por favor responde:\n\n1) Sí, voy en camino 🚀\n2) No puedo ir, cancelar cita`);
  }
}

// ─── RESPUESTA RECORDATORIO FRECUENCIA ───────────────────
async function manejarRespuestaFrecuencia(from, telefono, body, state) {
  const cliente = await getClienteByPhone(telefono);

  if (body === '1') {
    clienteState[telefono] = { paso: 'menu_principal', nombre: state.nombre };
    await mostrarMenu(from, state.nombre);
  } else if (body === '2') {
    if (cliente) {
      const nuevasCancelaciones = await sumarCancelacion(cliente.rowIndex, cliente.veces_cancelo);
      if (nuevasCancelaciones >= 3) {
        await borrarCliente(cliente.rowIndex);
        clienteState[telefono] = { paso: null };
        await sendMessage(from, `😔 Entendido.\n\nDebido a cancelaciones repetidas tu registro ha sido *eliminado*. Si deseas volver, regístrate nuevamente. ✂️`);
        return;
      }
      if (nuevasCancelaciones === 2) {
        await setProximoRecordatorio8Dias(cliente.rowIndex);
        clienteState[telefono] = { paso: null };
        await sendMessage(from, `😔 Entendido.\n\n⚠️ Esta es tu segunda cancelación. Te recordaremos en 8 días. ✂️`);
        return;
      }
      await setProximoRecordatorio8Dias(cliente.rowIndex);
    }
    clienteState[telefono] = { paso: null };
    await sendMessage(from, `😔 Entendido. Te recordaremos en 8 días. ✂️`);
  } else {
    await sendMessage(from, `⚠️ Por favor responde:\n\n1) Sí, quiero agendar\n2) No por ahora`);
  }
}

// ─── REAGENDAR POR ADMIN ─────────────────────────────────
async function manejarReagendadoPorAdmin(from, telefono, body, state) {
  const { diasAlternativos } = state;
  const idx = parseInt(body) - 1;
  const opcionEsperar = diasAlternativos.length;

  if (body === String(opcionEsperar + 1)) {
    clienteState[telefono] = { paso: null };
    await sendMessage(from, `✅ Perfecto, te contactaremos el próximo jueves para reagendar tu cita en *Saviac Estilo*. ✂️`);
    return;
  }

  if (isNaN(idx) || !diasAlternativos[idx]) {
    const opciones = diasAlternativos.map((d, i) => `${i+1}) ${d.label}`).join('\n');
    await sendMessage(from, `⚠️ Opción no válida.\n\n${opciones}\n${opcionEsperar + 1}) Esperar al próximo fin de semana`);
    return;
  }

  const diaElegido = diasAlternativos[idx];
  const slots = await getSlotsDisponibles(diaElegido.fecha);

  if (slots.length === 0) {
    clienteState[telefono] = { paso: null };
    await sendMessage(from, `😔 No hay horarios disponibles para el ${diaElegido.label}.\n\nTe contactaremos el próximo jueves. ✂️`);
    return;
  }

  const lista = slots.map((s, i) => `${i+1}) ${s}`).join('\n');
  clienteState[telefono] = { ...state, paso: 'eligiendo_hora', dia: diaElegido.label, fecha: diaElegido.fecha, slots };
  await sendMessage(from, `📅 Horarios disponibles para el *${diaElegido.label}*:\n\n${lista}\n\n_Responde con el número de tu opción_`);
}

// ─── NOMBRE NUEVO (fallback) ─────────────────────────────
async function manejarNombreNuevo(from, telefono, body, disponibilidadSemana) {
  const nombre = body;
  clienteState[telefono] = { paso: 'menu_principal', nombre };
  await mostrarMenu(from, nombre);
}

module.exports = { manejarCliente, clienteState };