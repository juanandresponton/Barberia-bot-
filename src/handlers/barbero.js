const { sendMessage } = require('../services/whatsapp');
const {
  guardarDisponibilidad, getCitas, updateEstadoCita,
  getClienteByPhone, marcarCitaCanceladaAdmin, sumarCitasCanceladasAdmin
} = require('../services/sheets');
const {
  notificarPendientesConHorarios,
  notificarPendientesNoAbre,
  getFechaProximoDia,
  primerNombre
} = require('./crons');
const { getSlotsDisponibles, cancelarCita } = require('../services/calendar');

const BARBER_PHONE = process.env.BARBER_PHONE;
const barberoState = {};

const VOLVER_MENU_ADMIN = `\n\n─────────────\nEscribe *menu* para volver al menú 🙌`;

// ─── MENÚ ADMIN ──────────────────────────────────────────
async function mostrarMenuAdmin(from) {
  await sendMessage(from,
    `👋 ¡Hola Admin! Bienvenido al panel de *Saviac Estilo* ✂️\n\n¿Qué deseas hacer?\n\n1️⃣ Ver citas de hoy\n2️⃣ Ver citas del fin de semana\n3️⃣ Cambiar disponibilidad\n\n_Responde con el número de tu opción_`
  );
}

async function manejarBarbero(from, body, disponibilidadSemana, setDisponibilidad, clienteState) {
  const state = barberoState[BARBER_PHONE] || { paso: null };
  console.log(`🔧 Barbero paso: ${state.paso} | body: ${body}`);

  // ─── VOLVER AL MENÚ ──────────────────────────────────
  if (body.toLowerCase() === 'menu') {
    barberoState[BARBER_PHONE] = { paso: 'menu_admin' };
    await mostrarMenuAdmin(from);
    return;
  }

  // ─── MENÚ ADMIN ──────────────────────────────────────
  if (state.paso === 'menu_admin' || state.paso === null) {
    if (body === '1') {
      await manejarVerCitasHoy(from);
      return;
    }
    if (body === '2') {
      await manejarVerCitasFinSemana(from, disponibilidadSemana);
      return;
    }
    if (body === '3') {
      barberoState[BARBER_PHONE] = { paso: 'cambiar_disponibilidad' };
      await sendMessage(from,
        `📅 ¿Qué día deseas cancelar?\n\n1) Viernes\n2) Sábado\n3) Domingo\n4) Todo el fin de semana\n\n_Responde con el número de tu opción_`
      );
      return;
    }
  }

  // ─── CAMBIAR DISPONIBILIDAD ───────────────────────────
  if (state.paso === 'cambiar_disponibilidad') {
    const diaMap = { '1': 'viernes', '2': 'sabado', '3': 'domingo', '4': 'todo' };
    const dia = diaMap[body];
    if (!dia) {
      await sendMessage(from, `⚠️ Opción no válida.\n\n1) Viernes\n2) Sábado\n3) Domingo\n4) Todo el fin de semana`);
      return;
    }
    barberoState[BARBER_PHONE] = { paso: 'confirmar_cancelacion_dia', dia };
    const diaTexto = dia === 'todo' ? 'todo el fin de semana' : `el ${dia}`;
    await sendMessage(from,
      `⚠️ ¿Seguro que deseas cancelar *${diaTexto}*?\n\nSe notificará a todos los clientes afectados.\n\n1) Sí, cancelar\n2) No, volver al menú`
    );
    return;
  }

  // ─── CONFIRMAR CANCELACIÓN DÍA ───────────────────────
  if (state.paso === 'confirmar_cancelacion_dia') {
    if (body === '2') {
      barberoState[BARBER_PHONE] = { paso: 'menu_admin' };
      await mostrarMenuAdmin(from);
      return;
    }
    if (body === '1') {
      await procesarCancelacionDia(from, state.dia, disponibilidadSemana, setDisponibilidad, clienteState);
      return;
    }
    await sendMessage(from, `⚠️ Responde *1* para confirmar o *2* para cancelar.`);
    return;
  }

  // ─── FLUJO DISPONIBILIDAD SEMANAL (desde cron jueves) ─
  if (state.paso === 'abre') {
    if (body === '1') {
      barberoState[BARBER_PHONE] = { ...state, paso: 'viernes' };
      await sendMessage(from,
        `📅 ¿Vas a trabajar el *viernes*?\n\n1) Sí, trabajo el viernes\n2) No, el viernes descanso\n\n_Responde con el número de tu opción_`
      );
    } else if (body === '2') {
      barberoState[BARBER_PHONE] = { paso: null };
      setDisponibilidad({ abre: false, viernes: false, sabado: false, domingo: false });
      await guardarDisponibilidad({ viernes: false, sabado: false, domingo: false });
      await sendMessage(from, `🔒 ¡Listo! Les avisaré a los clientes de *Saviac Estilo* que este fin de semana no hay servicio. Descansa bien 💈`);
      await notificarPendientesNoAbre(clienteState);
    } else {
      await sendMessage(from, `⚠️ No entendí.\n\n1) Sí, voy a abrir\n2) No, este fin descanso`);
    }
    return;
  }

  if (state.paso === 'viernes') {
    if (body === '1' || body === '2') {
      barberoState[BARBER_PHONE] = { ...state, paso: 'sabado', viernes: body === '1' };
      await sendMessage(from,
        `📅 ¿Vas a trabajar el *sábado*?\n\n1) Sí, trabajo el sábado\n2) No, el sábado descanso\n\n_Responde con el número de tu opción_`
      );
    } else {
      await sendMessage(from, `⚠️ Responde *1* para sí o *2* para no.`);
    }
    return;
  }

  if (state.paso === 'sabado') {
    if (body === '1' || body === '2') {
      barberoState[BARBER_PHONE] = { ...state, paso: 'domingo', sabado: body === '1' };
      await sendMessage(from,
        `📅 ¿Vas a trabajar el *domingo*?\n\n1) Sí, trabajo el domingo\n2) No, el domingo descanso\n\n_Responde con el número de tu opción_`
      );
    } else {
      await sendMessage(from, `⚠️ Responde *1* para sí o *2* para no.`);
    }
    return;
  }

  if (state.paso === 'domingo') {
    if (body === '1' || body === '2') {
      const domingo = body === '1';
      const sabado  = state.sabado;
      const viernes = state.viernes;

      if (!viernes && !sabado && !domingo) {
        barberoState[BARBER_PHONE] = { paso: null };
        setDisponibilidad({ abre: false, viernes: false, sabado: false, domingo: false });
        await guardarDisponibilidad({ viernes: false, sabado: false, domingo: false });
        await sendMessage(from, `🔒 ¡Entendido! Este fin de semana descansas. Ya les aviso a los clientes de *Saviac Estilo* 💈`);
        await notificarPendientesNoAbre(clienteState);
        return;
      }

      setDisponibilidad({ abre: true, viernes, sabado, domingo });
      barberoState[BARBER_PHONE] = { paso: null };
      await guardarDisponibilidad({ viernes, sabado, domingo });

      let resumen = `✅ ¡Perfecto! Quedó guardado:\n\n`;
      resumen += viernes ? `📅 *Viernes:* Abierto ✅\n` : `📅 *Viernes:* Cerrado ❌\n`;
      resumen += sabado  ? `📅 *Sábado:* Abierto ✅\n` : `📅 *Sábado:* Cerrado ❌\n`;
      resumen += domingo ? `📅 *Domingo:* Abierto ✅`  : `📅 *Domingo:* Cerrado ❌`;
      resumen += `\n\n¡Ya les aviso a los clientes de *Saviac Estilo*! 💈`;
      await sendMessage(from, resumen);
      await notificarPendientesConHorarios({ abre: true, viernes, sabado, domingo }, clienteState);
    } else {
      await sendMessage(from, `⚠️ Responde *1* para sí o *2* para no.`);
    }
    return;
  }

  // ─── CUALQUIER MENSAJE → MENÚ ADMIN ──────────────────
  barberoState[BARBER_PHONE] = { paso: 'menu_admin' };
  await mostrarMenuAdmin(from);
}

// ─── VER CITAS HOY ───────────────────────────────────────
async function manejarVerCitasHoy(from) {
  const ahoraColombia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const hoy = `${ahoraColombia.getFullYear()}-${String(ahoraColombia.getMonth()+1).padStart(2,'0')}-${String(ahoraColombia.getDate()).padStart(2,'0')}`;

  const citas = await getCitas();
  const citasHoy = citas.filter(c => c.fecha === hoy && c.estado === 'confirmada');

  if (citasHoy.length === 0) {
    await sendMessage(from, `📅 No hay citas confirmadas para hoy.${VOLVER_MENU_ADMIN}`);
    barberoState[BARBER_PHONE] = { paso: 'menu_admin' };
    return;
  }

  let msg = `📅 *Citas de hoy (${citasHoy.length}):*\n\n`;
  citasHoy.forEach((c, i) => {
    msg += `${i+1}) *${c.nombre}* — ${c.hora}\n`;
  });
  msg += VOLVER_MENU_ADMIN;

  await sendMessage(from, msg);
  barberoState[BARBER_PHONE] = { paso: 'menu_admin' };
}

// ─── VER CITAS FIN DE SEMANA ─────────────────────────────
async function manejarVerCitasFinSemana(from, disponibilidadSemana) {
  const fechaViernes = getFechaProximoDia(5);
  const fechaSabado  = getFechaProximoDia(6);
  const fechaDomingo = getFechaProximoDia(0);

  const citas = await getCitas();
  const citasFds = citas.filter(c =>
    (c.fecha === fechaViernes || c.fecha === fechaSabado || c.fecha === fechaDomingo) &&
    c.estado === 'confirmada'
  );

  if (citasFds.length === 0) {
    await sendMessage(from, `📅 No hay citas confirmadas para este fin de semana.${VOLVER_MENU_ADMIN}`);
    barberoState[BARBER_PHONE] = { paso: 'menu_admin' };
    return;
  }

  const diasNombres = { [fechaViernes]: 'Viernes', [fechaSabado]: 'Sábado', [fechaDomingo]: 'Domingo' };
  let msg = `📅 *Citas del fin de semana (${citasFds.length}):*\n\n`;
  citasFds.forEach((c, i) => {
    msg += `${i+1}) *${c.nombre}* — ${diasNombres[c.fecha] || c.fecha} ${c.hora}\n`;
  });
  msg += VOLVER_MENU_ADMIN;

  await sendMessage(from, msg);
  barberoState[BARBER_PHONE] = { paso: 'menu_admin' };
}

// ─── PROCESAR CANCELACIÓN DE UN DÍA ─────────────────────
async function procesarCancelacionDia(from, dia, disponibilidadSemana, setDisponibilidad, clienteState) {
  const fechaViernes = getFechaProximoDia(5);
  const fechaSabado  = getFechaProximoDia(6);
  const fechaDomingo = getFechaProximoDia(0);

  let fechasCanceladas = [];
  if (dia === 'viernes') fechasCanceladas = [fechaViernes];
  if (dia === 'sabado')  fechasCanceladas = [fechaSabado];
  if (dia === 'domingo') fechasCanceladas = [fechaDomingo];
  if (dia === 'todo')    fechasCanceladas = [fechaViernes, fechaSabado, fechaDomingo];

  // Actualizar disponibilidad
  const nuevaDisp = {
    abre:    disponibilidadSemana.abre,
    viernes: dia === 'viernes' || dia === 'todo' ? false : (disponibilidadSemana.viernes || false),
    sabado:  dia === 'sabado'  || dia === 'todo' ? false : disponibilidadSemana.sabado,
    domingo: dia === 'domingo' || dia === 'todo' ? false : disponibilidadSemana.domingo
  };
  if (!nuevaDisp.viernes && !nuevaDisp.sabado && !nuevaDisp.domingo) nuevaDisp.abre = false;
  setDisponibilidad(nuevaDisp);
  await guardarDisponibilidad(nuevaDisp);

  // Buscar citas afectadas
  const citas = await getCitas();
  const citasAfectadas = citas.filter(c =>
    fechasCanceladas.includes(c.fecha) && c.estado === 'confirmada'
  );

  if (citasAfectadas.length === 0) {
    await sendMessage(from, `✅ Disponibilidad actualizada. No había citas confirmadas para ese día.${VOLVER_MENU_ADMIN}`);
    barberoState[BARBER_PHONE] = { paso: 'menu_admin' };
    return;
  }

  // Días alternativos disponibles
  const diasAlternativos = [];
  if (nuevaDisp.viernes && !fechasCanceladas.includes(fechaViernes)) diasAlternativos.push({ label: 'viernes', fecha: fechaViernes });
  if (nuevaDisp.sabado  && !fechasCanceladas.includes(fechaSabado))  diasAlternativos.push({ label: 'sábado',  fecha: fechaSabado });
  if (nuevaDisp.domingo && !fechasCanceladas.includes(fechaDomingo)) diasAlternativos.push({ label: 'domingo', fecha: fechaDomingo });

  // Notificar a cada cliente afectado
  for (const cita of citasAfectadas) {
    // Cancelar en calendar
    if (cita.event_id) await cancelarCita(cita.event_id).catch(() => {});

    // Marcar como cancelada por admin
    await updateEstadoCita(cita.rowIndex, 'cancelada_admin');
    await marcarCitaCanceladaAdmin(cita.rowIndex);

    // Sumar contador en clientes (columna K)
    const cliente = await getClienteByPhone(cita.telefono);
    if (cliente) await sumarCitasCanceladasAdmin(cliente.rowIndex, cliente.citas_canceladas_admin);

    // Construir mensaje según días alternativos disponibles
    const destino = cliente?.whatsapp_lid || `${cita.telefono}@c.us`;
    const diaTexto = dia === 'todo' ? 'este fin de semana' : `el ${dia}`;

    if (diasAlternativos.length === 0) {
      // No hay días alternativos
      await sendMessage(destino,
        `😔 ¡Hola *${primerNombre(cita.nombre)}*! Lamentablemente ${diaTexto} no abriremos *Saviac Estilo*.\n\nTe contactaremos el próximo jueves para reagendar tu cita. ✂️`
      );
      if (cliente) clienteState[cliente.telefono] = { paso: null };
    } else {
      // Hay días alternativos
      let opciones = '';
      diasAlternativos.forEach((d, i) => { opciones += `${i+1}) Reagendar para el ${d.label}\n`; });
      opciones += `${diasAlternativos.length + 1}) Esperar al próximo fin de semana`;

      await sendMessage(destino,
        `😔 ¡Hola *${primerNombre(cita.nombre)}*! Lamentablemente ${diaTexto} no abriremos *Saviac Estilo*.\n\n¿Qué deseas hacer?\n\n${opciones}\n\n_Responde con el número de tu opción_`
      );

      // Guardar estado para que el cliente pueda reagendar
      if (cliente) {
        clienteState[cliente.telefono] = {
          paso: 'reagendando_por_admin',
          diasAlternativos,
          citaOriginalId: cita.id
        };
      }
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  const diaTexto = dia === 'todo' ? 'todo el fin de semana' : `el ${dia}`;
  await sendMessage(from,
    `✅ Listo. Se canceló *${diaTexto}* y se notificó a *${citasAfectadas.length}* cliente(s).${VOLVER_MENU_ADMIN}`
  );
  barberoState[BARBER_PHONE] = { paso: 'menu_admin' };
}

function setBarberoStep(paso) {
  barberoState[BARBER_PHONE] = { paso };
}

module.exports = { manejarBarbero, setBarberoStep };