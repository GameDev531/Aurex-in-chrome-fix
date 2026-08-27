// Runner: roda todos os *.test.js e devolve código de saída não-zero se algo falhar.
const fs = require('node:fs');
const path = require('node:path');
const { settle, summary } = require('./harness');

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
console.log('\x1b[1mAurex — suite de testes\x1b[0m');
files.forEach((f) => require(path.join(__dirname, f)));

// Espera os grupos assíncronos antes de resumir: um grupo que não terminou
// contaria como "sem falhas" e esconderia regressão.
settle().then(() => {
  process.exit(summary() ? 0 : 1);
});
