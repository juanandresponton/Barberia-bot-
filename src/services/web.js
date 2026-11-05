const http = require('http');
const QRCode = require('qrcode');

// Servidor mínimo: Render (plan gratis) necesita un puerto abierto y un ping para no dormir.
// /        → estado (sirve para el ping)
// /qr?key= → página con el QR para vincular WhatsApp (protegida con QR_KEY)

const PORT   = process.env.PORT || 3000;
const QR_KEY = process.env.QR_KEY || '';

let ultimoQR = null;
let estado   = 'iniciando';

const setQR     = (qr) => { ultimoQR = qr; estado = 'esperando_qr'; };
const setEstado = (e)  => { estado = e; if (e === 'conectado') ultimoQR = null; };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/qr') {
    if (!QR_KEY || url.searchParams.get('key') !== QR_KEY) {
      res.writeHead(403); return res.end('Prohibido');
    }
    let cuerpo;
    if (estado === 'conectado') {
      cuerpo = '<h2>✅ WhatsApp conectado</h2><p>No hay que escanear nada.</p>';
    } else if (ultimoQR) {
      const img = await QRCode.toDataURL(ultimoQR, { width: 320 });
      cuerpo = `<h2>📱 Escanea con WhatsApp</h2>
        <p>WhatsApp → Dispositivos vinculados → Vincular un dispositivo</p>
        <img src="${img}" alt="QR"><p><small>Se actualiza solo cada 15 s</small></p>`;
    } else {
      cuerpo = '<h2>⏳ Generando QR…</h2><p>Espera unos segundos.</p>';
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="refresh" content="15">
      <title>Barbería bot</title>
      <body style="font-family:system-ui;text-align:center;padding:24px">${cuerpo}</body>`);
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`ok · ${estado}`);
});

server.listen(PORT, () => console.log(`🌐 Servidor web en puerto ${PORT}`));

module.exports = { setQR, setEstado };
