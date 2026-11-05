const { join } = require('path');

// Guarda Chrome dentro del proyecto para que Render lo encuentre en runtime
module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
