const { sendMessage, getChatIdMap } = require('../services/whatsapp');
const {
  getPendientes, limpiarPendientes, getCitas,
  getClientes, getClienteByPhone, updateEstadoCita,
  sumarNoAsistio, guardarDisponibilidad, guardarLid,
  marcarRecordatorioCitaEnviado
} = require('../services/sheets');
const { getSlotsDisponibles } = require('../services/calendar');

function getFechaProximoDia(dia) {
  const ahoraColombia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const hoyDia = ahoraColombia.getDay();
  const diff   = (dia - hoyDia + 7) % 7;
  const fecha  = new Date(ahoraColombia);
  fecha.setDate(ahoraColombia.getDate() + diff);
  return `${fecha.getFullYear()}-${String(fecha.getMonth()+1).padStart(2,'0')}-${String(fecha.getDate()).padStart(2,'0')}`;
}

function primerNombre(nombre) {
  return nombre ? nombre.split(' ')[0] : null;
}

async function enviarBienvenidaNuevosClientes() {
  const clientes = await getClientes();
  const sinLid   = clientes.filter(c => c.telefono && !c.whatsapp_lid);
  if (sinLid.length === 0) return;
  console.log(`👋 Clientes sin LID: ${sinLid.length}`);

  for (const cliente of sinLid) {
    const destino = `${cliente.telefono}@c.us`;
    try {
      await sendMessage(destino,
        `✂️ ¡Hola *${primerNombre(cliente.nombre)}*! Bienvenido a *Saviac Estilo* 💈\n\nYa estás registrado en nuestro sistema. Cuando quieras agendar tu cita escríbenos aquí directamente 🙌`
      );
      // Pausa aleatoria 5-10 seg para evitar restricción de WhatsApp
      await new Promise(r => setTimeout(r, 5000 + Math.random() * 5000));

      const map = getChatIdMap();
      const lid = map[cliente.telefono.replace(/\D/g, '')];
      if (lid) {
        await guardarLid(cliente.rowIndex, lid);
        console.log(`✅ LID guardado para ${cliente.nombre}: ${lid}`);
      }
    } catch (e) {
      console.error(`❌ Error bienvenida ${cliente.nombre}:`, e.message);
    }
  }
}

async function notificarPendientesConHorarios(disponibilidadSemana, clienteState) {
  const pendientes = await getPendientes();
  if (pendientes.length === 0) { console.log('📭 Sin pendientes'); return; }
  const ambos = disponibilidadSemana.sabado && disponibilidadSemana.domingo;

  for (const p of pendientes) {
    const destino = p.from || `${p.telefono}@c.us`;
    if (ambos) {
      clienteState[p.telefono] = { paso: 'eligiendo_dia', nombre: p.nombre };
      await sendMessage(destino,
        `✂️ ¡Hola *${primerNombre(p.nombre)}*! *Saviac Estilo* confirmó horarios para este fin de semana 💈\n\n¿Qué día te viene mejor?\n\n1) Sábado\n2) Domingo\n\n_Responde con el número de tu opción_`
      );
    } else {
      const fecha     = disponibilidadSemana.sabado ? getFechaProximoDia(6) : getFechaProximoDia(0);
      const diaNombre = disponibilidadSemana.sabado ? 'sábado' : 'domingo';
      const slots     = await getSlotsDisponibles(fecha);
      const lista     = slots.map((s, i) => `${i + 1}) ${s}`).join('\n');
      clienteState[p.telefono] = { paso: 'eligiendo_hora', dia: disponibilidadSemana.sabado ? 'Sábado' : 'Domingo', fecha, slots, nombre: p.nombre };
      await sendMessage(destino,
        `✂️ ¡Hola *${primerNombre(p.nombre)}*! *Saviac Estilo* confirmó horarios para este *${diaNombre}* 💈\n\nEstos son los horarios disponibles:\n\n${lista}\n\n¿Cuál te queda mejor?\n\n_Responde con el número de tu opción_`
      );
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  await limpiarPendientes();
  console.log('🧹 Pendientes limpiados');
}

async function notificarPendientesNoAbre(clienteState) {
  const pendientes = await getPendientes();
  if (pendientes.length === 0) { console.log('📭 Sin pendientes'); return; }
  for (const p of pendientes) {
    const destino = p.from || `${p.telefono}@c.us`;
    await sendMessage(destino,
      `😔 ¡Hola *${primerNombre(p.nombre)}*! Este fin de semana *Saviac Estilo* estará cerrada.\n\nEl próximo viernes te avisamos. ✂️`
    );
    await new Promise(r => setTimeout(r, 1000));
  }
  await limpiarPendientes();
}

async function enviarRecordatorioDiaAnterior(clienteState) {
  const manana = new Date();
  manana.setDate(manana.getDate() + 1);
  const fechaManana = manana.toISOString().split('T')[0];
  const citas = await getCitas();
  const citasManana = citas.filter(c => c.fecha === fechaManana && c.estado === 'confirmada');
  console.log(`📅 Recordatorios día anterior: ${citasManana.length} citas`);

  for (const cita of citasManana) {
    const cliente = await getClienteByPhone(cita.telefono);
    const destino = cliente?.whatsapp_lid || `${cita.telefono}@c.us`;
    await sendMessage(destino,
      `✂️ ¡Hola *${primerNombre(cita.nombre)}*! Te recordamos que mañana tienes cita en *Saviac Estilo* a las *${cita.hora}* 💈\n\n1) Sí, confirmo asistencia\n2) Cancelar mi cita\n\n_Responde con el número de tu opción_`
    );
    clienteState[cita.telefono] = { paso: 'confirmando_cancelacion', citaId: cita.id };
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function enviarRecordatorio15Min(clienteState) {
  const ahoraColombia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const hoy = `${ahoraColombia.getFullYear()}-${String(ahoraColombia.getMonth()+1).padStart(2,'0')}-${String(ahoraColombia.getDate()).padStart(2,'0')}`;

  const citas = await getCitas();
  const citasHoy = citas.filter(c =>
    c.fecha === hoy &&
    c.estado === 'confirmada' &&
    c.recordatorio_enviado !== 'TRUE'
  );

  for (const cita of citasHoy) {
    const [horaParte, periodo] = cita.hora.split(' ');
    const [hStr, mStr] = horaParte.split(':');
    let h = parseInt(hStr);
    const m = parseInt(mStr);
    if (periodo === 'PM' && h !== 12) h += 12;
    if (periodo === 'AM' && h === 12) h = 0;

    const citaMinutos  = h * 60 + m;
    const ahoraMinutos = ahoraColombia.getHours() * 60 + ahoraColombia.getMinutes();
    const diff         = citaMinutos - ahoraMinutos;

    if (diff >= 13 && diff <= 17) {
      const cliente = await getClienteByPhone(cita.telefono);
      const destino = cliente?.whatsapp_lid || `${cita.telefono}@c.us`;

      await sendMessage(destino,
        `⏰ ¡*${primerNombre(cita.nombre)}*! Tu cita en *Saviac Estilo* es en *15 minutos* ✂️\n\n1) Sí, voy en camino 🚀\n2) No puedo ir, cancelar cita\n\n_Responde con el número de tu opción_`
      );

      await marcarRecordatorioCitaEnviado(cita.rowIndex);
      clienteState[cita.telefono] = { paso: 'recordatorio_15min', citaId: cita.id };
      console.log(`✅ Recordatorio 15min enviado a ${cita.nombre}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function enviarRecordatorioFrecuencia(disponibilidadSemana, clienteState) {
  const clientes = await getClientes();
  const hoy      = new Date();
  const sabado   = getFechaProximoDia(6);
  const domingo  = getFechaProximoDia(0);

  for (const cliente of clientes) {
    if (cliente.estado === 'inactivo') continue;
    if (!cliente.proximo_recordatorio) continue;

    const fechaRecordatorio = new Date(cliente.proximo_recordatorio);
    const diffDias = Math.floor((hoy - fechaRecordatorio) / (1000 * 60 * 60 * 24));
    if (diffDias < 0) continue;

    const citas = await getCitas();
    const tieneCita = citas.find(c =>
      c.telefono === cliente.telefono &&
      (c.fecha === sabado || c.fecha === domingo) &&
      c.estado === 'confirmada'
    );
    if (tieneCita) continue;

    const destino = cliente.whatsapp_lid || `${cliente.telefono}@c.us`;
    await sendMessage(destino,
      `✂️ ¡Hola *${primerNombre(cliente.nombre)}*! Según tu frecuencia de corte, este fin de semana te toca una visita a *Saviac Estilo* 💈\n\n¿Deseas agendar tu cita?\n\n1) Sí, quiero agendar\n2) No por ahora\n\n_Responde con el número de tu opción_`
    );
    clienteState[cliente.telefono] = { paso: 'recordatorio_frecuencia', nombre: cliente.nombre };
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function marcarNoAsistidos() {
  const ahoraColombia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const ayer = new Date(ahoraColombia);
  ayer.setDate(ayer.getDate() - 1);
  const fechaAyer = `${ayer.getFullYear()}-${String(ayer.getMonth()+1).padStart(2,'0')}-${String(ayer.getDate()).padStart(2,'0')}`;

  const citas = await getCitas();
  const citasAyer = citas.filter(c => c.fecha === fechaAyer && c.estado === 'confirmada');

  for (const cita of citasAyer) {
    await updateEstadoCita(cita.rowIndex, 'no_asistio');
    const cliente = await getClienteByPhone(cita.telefono);
    if (cliente) await sumarNoAsistio(cliente.rowIndex);
    console.log(`❌ Marcado no asistió: ${cita.nombre} | ${cita.fecha}`);
  }
}

module.exports = {
  notificarPendientesConHorarios,
  notificarPendientesNoAbre,
  enviarRecordatorioDiaAnterior,
  enviarRecordatorio15Min,
  enviarRecordatorioFrecuencia,
  marcarNoAsistidos,
  enviarBienvenidaNuevosClientes,
  getFechaProximoDia,
  primerNombre
};