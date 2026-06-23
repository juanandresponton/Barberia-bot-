async function enviarRecordatorioFrecuencia(disponibilidadSemana, clienteState) {
  const clientes = await getClientes();
  const hoy      = new Date();
  const viernes  = getFechaProximoDia(5);
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
      (c.fecha === viernes || c.fecha === sabado || c.fecha === domingo) &&
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