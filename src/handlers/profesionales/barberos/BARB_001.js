const { sendMessage } = require('../../../services/whatsapp');
const { guardarDisponibilidadProfesional } = require('../../../services/sheets');

const ID     = 'BARB_001';
const NOMBRE = 'Carlos Prueba';
const PHONE  = process.env.PROF_PHONE_BARB_001;
const profState = {};

function esProfesional(from) {
  return from === `${PHONE}@c.us` || from === `${PHONE}@lid`;
}

async function preguntarDisponibilidad() {
  profState[ID] = { paso: 'abre' };
  await sendMessage(`${PHONE}@c.us`,
    `✂️ ¡Hola *${NOMBRE}*! ¿Vas a trabajar este *fin de semana*?\n\n1) Sí, voy a trabajar\n2) No, este fin descanso\n\n_Responde con el número de tu opción_`
  );
}

async function mostrarMenu(from) {
  await sendMessage(from,
    `👋 ¡Hola *${NOMBRE}*! Panel de *Saviac Estilo* ✂️\n\n1️⃣ Ver mis citas de hoy\n2️⃣ Ver mis citas del fin de semana\n3️⃣ Actualizar mi disponibilidad\n\n_Responde con el número de tu opción_`
  );
}

async function manejarMensaje(from, body) {
  const state = profState[ID] || { paso: null };
  console.log(`🔧 ${NOMBRE} paso: ${state.paso} | body: ${body}`);

  if (body.toLowerCase() === 'menu') {
    profState[ID] = { paso: 'menu_prof' };
    await mostrarMenu(from);
    return;
  }

  if (state.paso === 'menu_prof') {
    if (body === '1') { await sendMessage(from, `📅 Próximamente: ver citas de hoy.`); profState[ID] = { paso: null }; return; }
    if (body === '2') { await sendMessage(from, `📅 Próximamente: ver citas del fin de semana.`); profState[ID] = { paso: null }; return; }
    if (body === '3') { profState[ID] = { paso: 'abre' }; await sendMessage(from, `📅 ¿Vas a trabajar este *fin de semana*?\n\n1) Sí\n2) No`); return; }
    await mostrarMenu(from);
    return;
  }

  if (state.paso === 'abre') {
    if (body === '1') { profState[ID] = { ...state, paso: 'viernes' }; await sendMessage(from, `📅 ¿El *viernes*?\n\n1) Sí\n2) No`); }
    else if (body === '2') { await guardarDisponibilidadProfesional({ profesionalId: ID, viernes: false, sabado: false, domingo: false }); profState[ID] = { paso: null }; await sendMessage(from, `🔒 Listo *${NOMBRE}*, no disponible este fin de semana. ¡Descansa! 💈`); }
    else await sendMessage(from, `⚠️ Responde *1* o *2*.`);
    return;
  }

  if (state.paso === 'viernes') {
    if (body === '1' || body === '2') { profState[ID] = { ...state, paso: 'sabado', viernes: body === '1' }; await sendMessage(from, `📅 ¿El *sábado*?\n\n1) Sí\n2) No`); }
    else await sendMessage(from, `⚠️ Responde *1* o *2*.`);
    return;
  }

  if (state.paso === 'sabado') {
    if (body === '1' || body === '2') { profState[ID] = { ...state, paso: 'domingo', sabado: body === '1' }; await sendMessage(from, `📅 ¿El *domingo*?\n\n1) Sí\n2) No`); }
    else await sendMessage(from, `⚠️ Responde *1* o *2*.`);
    return;
  }

  if (state.paso === 'domingo') {
    if (body === '1' || body === '2') {
      const domingo = body === '1';
      const { sabado, viernes } = state;
      await guardarDisponibilidadProfesional({ profesionalId: ID, viernes, sabado, domingo });
      profState[ID] = { paso: null };
      let resumen = `✅ ¡Listo *${NOMBRE}*!\n\n`;
      resumen += viernes ? `📅 *Viernes:* ✅\n` : `📅 *Viernes:* ❌\n`;
      resumen += sabado  ? `📅 *Sábado:* ✅\n` : `📅 *Sábado:* ❌\n`;
      resumen += domingo ? `📅 *Domingo:* ✅` : `📅 *Domingo:* ❌`;
      await sendMessage(from, resumen);
    } else await sendMessage(from, `⚠️ Responde *1* o *2*.`);
    return;
  }

  profState[ID] = { paso: 'menu_prof' };
  await mostrarMenu(from);
}

module.exports = { esProfesional, manejarMensaje, preguntarDisponibilidad, ID, NOMBRE, PHONE };