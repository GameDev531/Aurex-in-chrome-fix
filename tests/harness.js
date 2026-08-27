// Harness mínimo de testes para a extensão.
//
// A extensão é um script clássico (sem módulos) que depende de APIs do Chrome.
// Em vez de refatorar tudo para poder importar, extraímos blocos de código por
// marcador e os avaliamos com as APIs do Chrome simuladas. É pragmático e
// pega regressão de verdade nas funções puras, que é onde moram os bugs sutis.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
const failures = [];

function readSource(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

// Extrai o trecho entre dois marcadores (exclusivo no fim)
function extractBlock(file, startMarker, endMarker) {
  const src = readSource(file);
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`Marcador inicial não encontrado em ${file}: ${startMarker}`);
  const end = endMarker ? src.indexOf(endMarker, start) : src.length;
  if (end === -1) throw new Error(`Marcador final não encontrado em ${file}: ${endMarker}`);
  return src.slice(start, end === -1 ? undefined : end);
}

function check(description, condition, detail) {
  if (condition) {
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + description);
  } else {
    failed++;
    failures.push(description + (detail ? ' — ' + detail : ''));
    console.log('  \x1b[31m✗\x1b[0m ' + description + (detail ? ' — ' + detail : ''));
  }
}

function equal(description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(description, ok, ok ? '' : `esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`);
}

// Grupos podem ser assíncronos. Registramos a promessa para o runner esperar:
// um grupo async que "passa" sem ter rodado é pior que não existir.
const pending = [];

function group(title, fn) {
  console.log('\n\x1b[1m' + title + '\x1b[0m');
  let result;
  try {
    result = fn();
  } catch (err) {
    failed++;
    failures.push(title + ' lançou: ' + err.message);
    console.log('  \x1b[31m✗ exceção:\x1b[0m ' + err.message);
    return;
  }
  if (result && typeof result.then === 'function') {
    pending.push(
      result.catch((err) => {
        failed++;
        failures.push(title + ' lançou (async): ' + err.message);
        console.log('  \x1b[31m✗ exceção async:\x1b[0m ' + err.message);
      })
    );
  }
}

async function settle() {
  await Promise.all(pending);
}

function summary() {
  console.log('\n' + '─'.repeat(56));
  console.log(`${passed} passaram, ${failed} falharam`);
  if (failures.length) {
    console.log('\nFalhas:');
    failures.forEach((f) => console.log('  • ' + f));
  }
  return failed === 0;
}

// Simula o mínimo de localStorage usado pelo código da extensão
function fakeLocalStorage(initial = {}) {
  const store = Object.assign({}, initial);
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _store: store
  };
}

module.exports = { readSource, extractBlock, check, equal, group, settle, summary, fakeLocalStorage, ROOT };
