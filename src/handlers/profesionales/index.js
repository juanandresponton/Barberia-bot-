const BARB_001  = require('./barberos/BARB_001');
const BARB_002  = require('./barberos/BARB_002');
const BARB_003  = require('./barberos/BARB_003');
const ESTIL_001 = require('./estilistas/ESTIL_001');
const MANI_001  = require('./manicuristas/MANI_001');
const MANI_002  = require('./manicuristas/MANI_002');

const profesionales = [ BARB_001, BARB_002, BARB_003, ESTIL_001, MANI_001, MANI_002 ];

function detectarProfesional(from) {
  return profesionales.find(p => p.esProfesional(from)) || null;
}

async function manejarProfesional(from, body, disponibilidadSemana, setDisponibilidad, clienteState) {
  const prof = detectarProfesional(from);
  if (!prof) return false;
  await prof.manejarMensaje(from, body, disponibilidadSemana, setDisponibilidad, clienteState);
  return true;
}

async function preguntarDisponibilidadTodos() {
  console.log('📤 Preguntando disponibilidad a todos los profesionales...');
  for (const prof of profesionales) {
    try {
      await prof.preguntarDisponibilidad();
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.error(`❌ Error preguntando disponibilidad a ${prof.NOMBRE}:`, e.message);
    }
  }
}

module.exports = { manejarProfesional, detectarProfesional, preguntarDisponibilidadTodos };
