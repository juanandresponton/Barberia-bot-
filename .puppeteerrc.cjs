const { join } = require('path');

// Guarda Chrome dentro del proyecto (carpeta sin punto) para que Render lo incluya en el build
module.exports = {
  cacheDirectory: join(__dirname, 'chrome-cache'),
};
