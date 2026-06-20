const { sendMessage } = require('../services/whatsapp');
const {
  getClienteByPhone, guardarLid, agregarPendienteSheet,
  getCitas, updateEstadoCita, sumarCancelacion, sumarNoAsistio,
  actualizarUltimoCorte, marcarClienteInactivo, updateCliente,
  normalizarTelefono, agregarCita, resetearCancelaciones,
  setProximoRecordatorio8Dias, borrarCliente
} = require('../services/sheets');
const { getSlotsDisponibles, crearCita, cancelarCita } = require('../services/calendar');
const { getFechaProximoDia, primerNombre } = require('./crons');

const clienteState = {};

const VOLVER_MENU = `\n\n─────────────\nEscribe *1* para volver al menú 🙌`;

function nombreDia(fecha) {
  const d = new Date(fecha + 'T12:00:00-05:00');
  return d.toLocaleDateString('es-CO', { weekday: 'long', timeZone: 'America/Bogota' });
}

async function mostrarMenu(from, nombre) {
  const saludo = primerNombre(nombre) ? `Hola *${primerNombre(nombre)}* 👋` : 'Hola 👋';
  await sendMessage(from,
    `${saludo}, bienvenido a la barbería ✂️\n\nCon gusto te ayudamos a gestionar tu cita. ¿Qué deseas hacer?\n\n1️⃣ Agendar una cita\n2️⃣ Cancelar mi cita\n3️⃣ Ver mi cita actual\n\n_Responde con el número de tu opción_`
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
        } else {
          telefono = numReal;
        }
        if (cliente) console.log(`✅ Cliente encontrado por getContact: ${cliente.nombre}`);
      }
    } catch (e) { console.log(`⚠️ getContact falló: ${e.message}`); }
  }

  if (from.includes('@lid') && cliente && !cliente.whatsapp_lid) {
    await guardarLid(cliente.rowIndex, from);
    console.log(`💾 LID guardado para ${cliente.nombre}`);
  }

  if (state.paso === 'menu')                          { await manejarMenu(from, telefono, body, cliente, disponibilidadSemana); return; }
  if (state.paso === 'eligiendo_dia')                 { await manejarEligiendoDia(from, telefono, body, state, disponibilidadSemana); return; }
  if (state.paso === 'eligiendo_hora')                { await manejarEligiendoHora(from, telefono, body, state); return; }
  if (state.paso === 'esperando_nombre')              { await manejarNombreNuevo(from, telefono, body, disponibilidadSemana); return; }
  if (state.paso === 'confirmando_cancelacion')       { await manejarConfirmacionCancelacion(from, telefono, body, state); return; }
  if (state.paso === 'confirmando_cancelacion_final') { await manejarConfirmacionFinalCancelacion(from, telefono, body, state); return; }
  if (state.paso === 'recordatorio_15min')            { await manejarRespuestaRecordatorio(from, telefono, body, state); return; }
  if (state.paso === 'recordatorio_frecuencia')       { await manejarRespuestaFrecuencia(from, telefono, body, state); return; }

  if (cliente && cliente.estado === 'inactivo') {
    await sendMessage(from, `😔 Hola *${primerNombre(cliente.nombre)}*! En este momento tu cuenta no está activa.\n\nVisita la barbería para más información. ✂️`);
    return;
  }

  const nombre = cliente ? cliente.nombre : null;
  clienteState[telefono] = { paso: 'menu', nombre };
  await mostrarMenu(from, nombre);
}

async function manejarMenu(from, telefono, body, cliente, disponibilidadSemana) {
  const nombre = clienteState[telefono]?.nombre || (cliente ? cliente.nombre : null);

  if (body === '1') {
    clienteState[telefono] = { paso: null, nombre };

    if (disponibilidadSemana.abre === false) {
      await sendMessage(from, `😔 Este fin de semana la barbería estará cerrada.\n\nEl próximo viernes te avisamos. ✂️${VOLVER_MENU}`);
      return;
    }

    if (disponibilidadSemana.abre === true) {
      const citas        = await getCitas();
      const fechaSabado  = getFechaProximoDia(6);
      const fechaDomingo = getFechaProximoDia(0);
      const tieneCita    = citas.find(c =>
        c.telefono === telefono &&
        (c.fecha === fechaSabado || c.fecha === fechaDomingo) &&
        c.estado === 'confirmada'
      );

      if (tieneCita) {
        clienteState[telefono] = { paso: 'confirmando_cancelacion', citaId: tieneCita.id, nombre };
        await sendMessage(from,
          `✅ Ya tienes una cita agendada para el *${nombreDia(tieneCita.fecha)}* a las *${tieneCita.hora}* ✂️\n\nSi deseas cancelar:\n1) Cancelar mi cita\n2) Volver al menú\n\n_Responde con el número de tu opción_`
        );
        return;
      }

      if (!nombre) { clienteState[telefono] = { paso: 'esperando_nombre' }; await sendMessage(from, `✂️ ¿Cuál es tu nombre?`); return; }
      await mostrarOpcionesAgendamiento(from, nombre, telefono, disponibilidadSemana);
      return;
    }

    if (!nombre) { clienteState[telefono] = { paso: 'esperando_nombre' }; await sendMessage(from, `✂️ ¿Cuál es tu nombre?`); return; }
    await agregarPendienteSheet({ telefono, nombre, from });
    await sendMessage(from, `✂️ El jueves cuando el barbero confirme horarios te avisamos directamente. No tienes que escribir de nuevo 👍${VOLVER_MENU}`);
    return;
  }

  if (body === '2') {
    const citas        = await getCitas();
    const fechaSabado  = getFechaProximoDia(6);
    const fechaDomingo = getFechaProximoDia(0);
    const citaActiva   = citas.find(c =>
      c.telefono === telefono &&
      (c.fecha === fechaSabado || c.fecha === fechaDomingo) &&
      c.estado === 'confirmada'
    );

    if (!citaActiva) {
      clienteState[telefono] = { paso: null };
      await sendMessage(from, `❌ No tienes ninguna cita activa para cancelar. ✂️${VOLVER_MENU}`);
      return;
    }

    clienteState[telefono] = { paso: 'confirmando_cancelacion_final', citaId: citaActiva.id, nombre };
    await sendMessage(from,
      `⚠️ ¿Seguro que deseas cancelar tu cita del *${nombreDia(citaActiva.fecha)}* a las *${citaActiva.hora}*?\n\n1) Sí, cancelar definitivamente\n2) No, mantener mi cita\n\n_Responde con el número de tu opción_`
    );
    return;
  }

  if (body === '3') {
    const citas        = await getCitas();
    const fechaSabado  = getFechaProximoDia(6);
    const fechaDomingo = getFechaProximoDia(0);
    const citaActiva   = citas.find(c =>
      c.telefono === telefono &&
      (c.fecha === fechaSabado || c.fecha === fechaDomingo) &&
      c.estado === 'confirmada'
    );

    if (!citaActiva) {
      clienteState[telefono] = { paso: null };
      await sendMessage(from, `📅 No tienes ninguna cita agendada para este fin de semana. ✂️${VOLVER_MENU}`);
      return;
    }

    clienteState[telefono] = { paso: 'confirmando_cancelacion', citaId: citaActiva.id, nombre };
    await sendMessage(from,
      `📅 *Tu cita actual:*\n\n👤 *Nombre:* ${citaActiva.nombre}\n📅 *Día:* ${nombreDia(citaActiva.fecha)}\n⏰ *Hora:* ${citaActiva.hora}\n\nSi deseas cancelar:\n1) Cancelar mi cita\n2) Volver al menú\n\n_Responde con el número de tu opción_`
    );
    return;
  }

  await mostrarMenu(from, nombre);
}

async function mostrarOpcionesAgendamiento(from, nombre, telefono, disponibilidadSemana) {
  const nombreActual = clienteState[telefono]?.nombre || nombre;
  const ambos        = disponibilidadSemana.sabado && disponibilidadSemana.domingo;

  if (ambos) {
    clienteState[telefono] = { paso: 'eligiendo_dia', nombre: nombreActual };
    await sendMessage(from, `✂️ Este fin de semana tenemos disponibilidad 💈\n\n¿Qué día te viene mejor?\n\n1) Sábado\n2) Domingo\n\n_Responde con el número de tu opción_`);
  } else {
    const fecha     = disponibilidadSemana.sabado ? getFechaProximoDia(6) : getFechaProximoDia(0);
    const diaNombre = disponibilidadSemana.sabado ? 'sábado' : 'domingo';
    const slots     = await getSlotsDisponibles(fecha);

    if (slots.length === 0) {
      await sendMessage(from, `😔 Lo sentimos, ya no hay horarios disponibles para este fin de semana.\n\nEl próximo viernes te avisamos. ✂️${VOLVER_MENU}`);
      return;
    }

    clienteState[telefono] = { paso: 'eligiendo_hora', dia: disponibilidadSemana.sabado ? 'Sábado' : 'Domingo', fecha, slots, nombre: nombreActual };
    const lista = slots.map((s, i) => `${i + 1}) ${s}`).join('\n');
    await sendMessage(from, `✂️ Este fin de semana abrimos el *${diaNombre}* 💈\n\nEstos son los horarios disponibles:\n\n${lista}\n\n_Responde con el número de tu opción_`);
  }
}

async function manejarEligiendoDia(from, telefono, body, state, disponibilidadSemana) {
  const soloDia = disponibilidadSemana.sabado !== disponibilidadSemana.domingo;
  if (body === '2' && soloDia) {
    const cliente = await getClienteByPhone(telefono);
    if (cliente) { const nf = new Date(); nf.setDate(nf.getDate() + 8); await updateCliente(cliente.rowIndex, 'G', nf.toISOString().split('T')[0]); }
    clienteState[telefono] = { paso: null };
    await sendMessage(from, `👍 ¡Sin problema! Te recordaremos en 8 días. ✂️${VOLVER_MENU}`);
    return;
  }

  const dias = [];
  if (disponibilidadSemana.sabado)  dias.push({ label: 'Sábado',  fecha: getFechaProximoDia(6) });
  if (disponibilidadSemana.domingo) dias.push({ label: 'Domingo', fecha: getFechaProximoDia(0) });

  const idx = parseInt(body) - 1;
  if (isNaN(idx) || !dias[idx]) {
    await sendMessage(from, `⚠️ Opción no válida. Responde con *1*${dias.length > 1 ? ' para Sábado o *2* para Domingo' : ''}.`);
    return;
  }

  const diaElegido = dias[idx];
  const slots      = await getSlotsDisponibles(diaElegido.fecha);

  if (slots.length === 0) {
    if (diaElegido.label === 'Sábado' && disponibilidadSemana.domingo) {
      const slotsDomingo = await getSlotsDisponibles(getFechaProximoDia(0));
      if (slotsDomingo.length > 0) {
        clienteState[telefono] = { paso: 'eligiendo_hora', dia: 'Domingo', fecha: getFechaProximoDia(0), slots: slotsDomingo, nombre: state.nombre };
        const lista = slotsDomingo.map((s, i) => `${i + 1}) ${s}`).join('\n');
        await sendMessage(from, `😔 Lo sentimos, ya no hay horarios para el *sábado*.\n\n¡Pero el *domingo* sí tenemos espacio! 💈\n\nEstos son los horarios disponibles:\n\n${lista}\n\n_Responde con el número de tu opción_`);
        return;
      }
    }
    clienteState[telefono] = { paso: null };
    await sendMessage(from, `😔 Lo sentimos, ya no hay horarios disponibles.\n\nEl próximo viernes te avisamos. ✂️${VOLVER_MENU}`);
    return;
  }

  clienteState[telefono] = { paso: 'eligiendo_hora', dia: diaElegido.label, fecha: diaElegido.fecha, slots, nombre: state.nombre };
  const lista = slots.map((s, i) => `${i + 1}) ${s}`).join('\n');
  await sendMessage(from, `📅 ¡Perfecto! Para el *${diaElegido.label}* tenemos estos horarios:\n\n${lista}\n\n_Responde con el número de tu opción_`);
}

async function manejarEligiendoHora(from, telefono, body, state) {
  const idx = parseInt(body) - 1;
  if (isNaN(idx) || !state.slots[idx]) { await sendMessage(from, `⚠️ Opción no válida. Por favor responde con un número de la lista.`); return; }

  const hora    = state.slots[idx];
  const cliente = await getClienteByPhone(telefono);
  const nombre  = state.nombre || (cliente ? cliente.nombre : 'Cliente');

  const eventId = await crearCita({ nombre, telefono, fecha: state.fecha, hora });
  const citaId  = await agregarCita({ telefono, nombre, fecha: state.fecha, hora, eventId });

  clienteState[telefono] = { paso: 'confirmando_cancelacion', citaId, nombre };
  await sendMessage(from,
    `🎉 ¡Listo *${primerNombre(nombre)}*! Tu cita quedó agendada.\n\n📅 *Día:* ${state.dia}\n⏰ *Hora:* ${hora}\n\n¡Te esperamos! 💈\n\nSi deseas cancelar:\n1) Cancelar mi cita\n2) Volver al menú\n\n_Responde con el número de tu opción_`
  );
  console.log(`✅ Cita agendada: ${nombre} | ${state.fecha} | ${hora}`);
}

async function manejarNombreNuevo(from, telefono, body, disponibilidadSemana) {
  const nombre = body;
  clienteState[telefono] = { paso: null, nombre };

  if (disponibilidadSemana.abre === false) {
    await sendMessage(from, `😔 ¡Hola *${primerNombre(nombre)}*! Este fin de semana la barbería estará cerrada.\n\nEl próximo viernes te avisamos. ✂️${VOLVER_MENU}`);
    return;
  }
  if (disponibilidadSemana.abre === true) { await mostrarOpcionesAgendamiento(from, nombre, telefono, disponibilidadSemana); return; }

  await agregarPendienteSheet({ telefono, nombre, from });
  await sendMessage(from, `✂️ ¡Hola *${primerNombre(nombre)}*! El jueves cuando el barbero confirme horarios te avisamos directamente. No tienes que escribir de nuevo 👍${VOLVER_MENU}`);
}

async function manejarConfirmacionCancelacion(from, telefono, body, state) {
  if (body === '1') {
    const citas      = await getCitas();
    const citaActiva = state.citaId
      ? citas.find(c => c.id === state.citaId)
      : citas.find(c => c.telefono === telefono && c.estado === 'confirmada');

    if (!citaActiva) {
      clienteState[telefono] = { paso: null };
      await sendMessage(from, `❌ No encontramos una cita activa para cancelar. ✂️${VOLVER_MENU}`);
      return;
    }

    clienteState[telefono] = { paso: 'confirmando_cancelacion_final', citaId: citaActiva.id, nombre: state.nombre };
    await sendMessage(from,
      `⚠️ ¿Seguro que deseas cancelar tu cita del *${nombreDia(citaActiva.fecha)}* a las *${citaActiva.hora}*?\n\n1) Sí, cancelar definitivamente\n2) No, mantener mi cita\n\n_Responde con el número de tu opción_`
    );
  } else {
    clienteState[telefono] = { paso: 'menu', nombre: state.nombre };
    await mostrarMenu(from, state.nombre);
  }
}

async function manejarConfirmacionFinalCancelacion(from, telefono, body, state) {
  if (body === '1') {
    const citas   = await getCitas();
    const cita    = citas.find(c => c.id === state.citaId);
    const cliente = await getClienteByPhone(telefono);

    if (cita) {
      await updateEstadoCita(cita.rowIndex, 'cancelada');
      if (cita.event_id) await cancelarCita(cita.event_id);
      console.log(`🗑️ Cita cancelada: ${cita.nombre} | ${cita.fecha} | ${cita.hora}`);
    }

    if (cliente) {
      const nuevasCancelaciones = await sumarCancelacion(cliente.rowIndex, cliente.veces_cancelo);

      if (nuevasCancelaciones >= 3) {
        await borrarCliente(cliente.rowIndex);
        clienteState[telefono] = { paso: null };
        await sendMessage(from,
          `😔 Tu cita fue cancelada.\n\nDebido a cancelaciones repetidas tu registro ha sido *eliminado* de nuestra base de datos.\n\nSi deseas volver, regístrate nuevamente escaneando nuestro QR en la barbería. ✂️`
        );
        return;
      }

      if (nuevasCancelaciones === 2) {
        await setProximoRecordatorio8Dias(cliente.rowIndex);
        clienteState[telefono] = { paso: null };
        await sendMessage(from,
          `😔 Tu cita fue cancelada.\n\n⚠️ *Atención:* Esta es tu segunda cancelación. Si cancelas una vez más, tu registro será eliminado.\n\nTe recordaremos en 8 días. ✂️${VOLVER_MENU}`
        );
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
    clienteState[telefono] = { paso: 'menu', nombre: state.nombre };
    await mostrarMenu(from, state.nombre);
  }
}

// ─── RESPUESTA RECORDATORIO 15 MIN ───────────────────────
async function manejarRespuestaRecordatorio(from, telefono, body, state) {
  const cliente = await getClienteByPhone(telefono);
  const citas   = await getCitas();
  const cita    = citas.find(c => c.id === state.citaId);

  if (body === '1') {
    // ✅ Va en camino
    clienteState[telefono] = { paso: null };
    await sendMessage(from,
      `✅ ¡Perfecto *${primerNombre(cliente?.nombre)}*! Te esperamos en la barbería. Hasta pronto ✂️${VOLVER_MENU}`
    );
    if (cliente && cita) {
      await updateEstadoCita(cita.rowIndex, 'asistio');
      await resetearCancelaciones(cliente.rowIndex);
      if (cliente.frecuencia) await actualizarUltimoCorte(cliente.rowIndex, cliente.frecuencia);
    }

  } else if (body === '2') {
    // ❌ Cancela
    if (cita) {
      await updateEstadoCita(cita.rowIndex, 'cancelada');
      if (cita.event_id) await cancelarCita(cita.event_id);
    }

    if (cliente) {
      const nuevasCancelaciones = await sumarCancelacion(cliente.rowIndex, cliente.veces_cancelo);

      if (nuevasCancelaciones >= 3) {
        await borrarCliente(cliente.rowIndex);
        clienteState[telefono] = { paso: null };
        await sendMessage(from,
          `😔 Tu cita fue cancelada.\n\nDebido a cancelaciones repetidas tu registro ha sido *eliminado* de nuestra base de datos.\n\nSi deseas volver, regístrate nuevamente escaneando nuestro QR en la barbería. ✂️`
        );
        return;
      }

      if (nuevasCancelaciones === 2) {
        await setProximoRecordatorio8Dias(cliente.rowIndex);
        clienteState[telefono] = { paso: null };
        await sendMessage(from,
          `😔 Cita cancelada.\n\n⚠️ *Atención:* Esta es tu segunda cancelación. Si cancelas una vez más, tu registro será eliminado.\n\nTe recordaremos en 8 días. ✂️${VOLVER_MENU}`
        );
        return;
      }

      await setProximoRecordatorio8Dias(cliente.rowIndex);
    }

    clienteState[telefono] = { paso: null };
    await sendMessage(from, `😔 Cita cancelada. Te recordaremos en 8 días. ✂️${VOLVER_MENU}`);

  } else {
    await sendMessage(from,
      `⚠️ Por favor responde:\n\n1) Sí, voy en camino 🚀\n2) No puedo ir, cancelar cita\n\n_Responde con el número de tu opción_`
    );
  }
}

// ─── RESPUESTA RECORDATORIO FRECUENCIA ───────────────────
async function manejarRespuestaFrecuencia(from, telefono, body, state) {
  const cliente = await getClienteByPhone(telefono);

  if (body === '1') {
    clienteState[telefono] = { paso: 'menu', nombre: state.nombre };
    await mostrarMenu(from, state.nombre);

  } else if (body === '2') {
    if (cliente) {
      const nuevasCancelaciones = await sumarCancelacion(cliente.rowIndex, cliente.veces_cancelo);

      if (nuevasCancelaciones >= 3) {
        await borrarCliente(cliente.rowIndex);
        clienteState[telefono] = { paso: null };
        await sendMessage(from,
          `😔 Entendido.\n\nDebido a cancelaciones repetidas tu registro ha sido *eliminado* de nuestra base de datos.\n\nSi deseas volver, regístrate nuevamente escaneando nuestro QR en la barbería. ✂️`
        );
        return;
      }

      if (nuevasCancelaciones === 2) {
        await setProximoRecordatorio8Dias(cliente.rowIndex);
        clienteState[telefono] = { paso: null };
        await sendMessage(from,
          `😔 Entendido.\n\n⚠️ *Atención:* Esta es tu segunda cancelación. Si la próxima vez tampoco asistes, tu registro será eliminado.\n\nTe recordaremos en 8 días. ✂️`
        );
        return;
      }

      await setProximoRecordatorio8Dias(cliente.rowIndex);
    }

    clienteState[telefono] = { paso: null };
    await sendMessage(from, `😔 Entendido. Te recordaremos en 8 días. ✂️`);

  } else {
    await sendMessage(from,
      `⚠️ Por favor responde:\n\n1) Sí, quiero agendar\n2) No por ahora\n\n_Responde con el número de tu opción_`
    );
  }
}

module.exports = { manejarCliente, clienteState };