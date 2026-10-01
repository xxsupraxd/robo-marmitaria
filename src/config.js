const fs = require('fs');
const path = require('path');

const FILE = process.env.CONFIG_FILE || path.join(__dirname, '..', 'config.json');
let config = JSON.parse(fs.readFileSync(FILE, 'utf8'));

function get() {
  return config;
}

// Mescla só um nível abaixo (ex.: { impressora: { modo: 'rede' } } não apaga o resto da impressora).
function update(parcial) {
  for (const [k, v] of Object.entries(parcial || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && config[k] && typeof config[k] === 'object') {
      config[k] = { ...config[k], ...v };
    } else {
      config[k] = v;
    }
  }
  fs.writeFileSync(FILE, JSON.stringify(config, null, 2) + '\n');
  return config;
}

module.exports = { get, update };
