const { sendMessage } = require('../services/whatsapp');
const { guardarDisponibilidad } = require('../services/sheets');
const {
  notificarPendientesConHorarios,
  notificarPendientesNoAbre
} = require('./crons');

const BARBER_PHONE = process.env.BARBER_PHONE;
const barberoState = {};

async function manejarBarbero(from, body, disponibilidadSemana, setDisponibilidad, clienteState) {
  const state = barberoState[BARBER_PHONE] || { paso: null };
  console.log(`🔧 Barbero paso: ${state.paso} | body: ${body}`);

  if (state.paso === 'abre') {
    if (body === '1') {
      barberoState[BARBER_PHONE] = { ...state, paso: 'sabado' };
      await sendMessage(from,
        `📅 ¿Vas a trabajar el *sábado*?\n\n1) Sí, trabajo el sábado\n2) No, el sábado descanso\n\n_Responde con el número de tu opción_`
      );
    } else if (body === '2') {
      barberoState[BARBER_PHONE] = { paso: null };
      setDisponibilidad({ abre: false, sabado: false, domingo: false });
      await guardarDisponibilidad({ sabado: false, domingo: false });
      await sendMessage(from, `🔒 ¡Listo! Les avisaré a los clientes que este fin de semana no hay servicio. Descansa bien 💈`);
      await notificarPendientesNoAbre(clienteState);
    } else {
      await sendMessage(from, `⚠️ No entendí.\n\n¿Vas a abrir este *fin de semana*?\n\n1) Sí, voy a abrir\n2) No, este fin descanso\n\n_Responde con el número de tu opción_`);
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
      await sendMessage(from, `⚠️ No entendí.\n\n¿Trabajas el *sábado*?\n\n1) Sí\n2) No\n\n_Responde con el número de tu opción_`);
    }
    return;
  }

  if (state.paso === 'domingo') {
    if (body === '1' || body === '2') {
      const domingo = body === '1';
      const sabado  = state.sabado;

      if (!sabado && !domingo) {
        barberoState[BARBER_PHONE] = { paso: null };
        setDisponibilidad({ abre: false, sabado: false, domingo: false });
        await guardarDisponibilidad({ sabado: false, domingo: false });
        await sendMessage(from, `🔒 ¡Entendido! Este fin de semana descansas. Ya les aviso a los clientes 💈`);
        await notificarPendientesNoAbre(clienteState);
        return;
      }

      setDisponibilidad({ abre: true, sabado, domingo });
      barberoState[BARBER_PHONE] = { paso: null };
      await guardarDisponibilidad({ sabado, domingo });

      let resumen = `✅ ¡Perfecto! Quedó guardado:\n\n`;
      resumen += sabado  ? `📅 *Sábado:* Abierto ✅\n` : `📅 *Sábado:* Cerrado ❌\n`;
      resumen += domingo ? `📅 *Domingo:* Abierto ✅`  : `📅 *Domingo:* Cerrado ❌`;
      resumen += `\n\n¡Ya les aviso a los clientes! 💈`;
      await sendMessage(from, resumen);
      await notificarPendientesConHorarios({ abre: true, sabado, domingo }, clienteState);
    } else {
      await sendMessage(from, `⚠️ No entendí.\n\n¿Trabajas el *domingo*?\n\n1) Sí\n2) No\n\n_Responde con el número de tu opción_`);
    }
    return;
  }

  await sendMessage(from, `👋 Por ahora no hay nada pendiente. ¡Hasta pronto!`);
}

function setBarberoStep(paso) {
  barberoState[BARBER_PHONE] = { paso };
}

module.exports = { manejarBarbero, setBarberoStep };