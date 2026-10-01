// Armazenamento simples em arquivos JSON na pasta data (para backup, é só copiar a pasta).
//   data/db.json              cardápios, contatos, conversas, contas de clientes, recebimentos, caixas
//   data/pedidos/AAAA-MM.json os pedidos, um arquivo por mês
// Os pedidos ficam separados porque o histórico cresce todo dia: assim cada gravação escreve só o mês
// que mudou, e não o histórico inteiro.
const fs = require('fs');
const path = require('path');
const { hoje } = require('./util');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'db.json');
const PASTA_PEDIDOS = path.join(DATA_DIR, 'pedidos');

let db = null;
const mesesSujos = new Set(); // meses com pedido alterado que ainda não foram gravados

const mesDe = (p) => String(p.data || '').slice(0, 7);

// Lê um JSON. Se a luz caiu bem na hora de trocar o arquivo, a cópia .tmp (já completa) é usada.
function lerJson(arq) {
  try {
    return JSON.parse(fs.readFileSync(arq, 'utf8'));
  } catch (e) {
    if (fs.existsSync(arq + '.tmp')) {
      try { return JSON.parse(fs.readFileSync(arq + '.tmp', 'utf8')); } catch {}
    }
    throw new Error(`Arquivo de dados estragado: ${arq} (${e.message}). Restaure da cópia de segurança da pasta data.`);
  }
}

function lerPedidos() {
  const porId = new Map();
  if (fs.existsSync(PASTA_PEDIDOS)) {
    for (const f of fs.readdirSync(PASTA_PEDIDOS).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort()) {
      for (const p of lerJson(path.join(PASTA_PEDIDOS, f))) porId.set(p.id, p);
    }
  }
  return porId;
}

function load() {
  if (db) return db;
  // Arquivo que não existe = sistema novo. Arquivo estragado é erro: melhor parar do que gravar por cima
  // e perder as contas dos clientes.
  db = fs.existsSync(FILE) || fs.existsSync(FILE + '.tmp') ? lerJson(FILE) : {};
  db.cardapios ??= {};     // 'AAAA-MM-DD' -> cardápio do dia
  db.contatos ??= {};      // telefone -> { telefone, nome, endereco, recebeCardapio, criadoEm }
  db.conversas ??= {};     // telefone -> { telefone, nome, estado, rascunho, carrinho, roboPausado, mensagens[], naoLidas, atualizadoEm }
  db.seqPedido ??= 0;
  db.disparos ??= [];      // histórico dos envios do cardápio
  db.contas ??= {};        // id -> { id, tipo: 'empresa'|'pessoa', nome, telefone, anotar, obs, criadoEm }
  db.seqConta ??= 0;
  db.recebimentos ??= [];  // pagamentos de contas anotadas: { id, contaId, valor, forma, data, em, obs, cancelado }
  db.seqRecebimento ??= 0;
  db.caixas ??= {};        // 'AAAA-MM-DD' -> { abertura, sangrias[], fechamento }

  // Versões antigas guardavam todos os pedidos dentro do db.json: passam para os arquivos por mês.
  const porId = lerPedidos();
  for (const p of Array.isArray(db.pedidos) ? db.pedidos : []) {
    porId.set(p.id, p);
    mesesSujos.add(mesDe(p));
  }
  db.pedidos = [...porId.values()].sort((a, b) => a.id - b.id);
  db.seqPedido = db.pedidos.reduce((m, p) => Math.max(m, p.id), db.seqPedido);
  // Se a luz caiu entre gravar os pedidos e o db.json, os contadores e as contas podem ter ficado para
  // trás: acerta, para nunca dar o número de uma conta que já existe a outro cliente.
  const maxId = (lista, f) => lista.reduce((m, x) => Math.max(m, Number(f(x)) || 0), 0);
  db.seqConta = Math.max(db.seqConta, maxId(Object.keys(db.contas), (k) => k), maxId(db.pedidos, (p) => p.contaId), maxId(db.recebimentos, (r) => r.contaId));
  db.seqRecebimento = Math.max(db.seqRecebimento, maxId(db.recebimentos, (r) => r.id));
  for (const id of new Set([...db.pedidos.map((p) => p.contaId), ...db.recebimentos.map((r) => r.contaId)])) {
    if (id && !db.contas[id]) db.contas[id] = { id, tipo: 'pessoa', nome: `Conta recuperada #${id}`, telefone: '', anotar: false, obs: '', criadoEm: new Date().toISOString() };
  }
  return db;
}

// Pedido de um mês antigo alterado (ex.: forma de pagamento corrigida): grava aquele mês também.
function marcarSujo(pedido) {
  mesesSujos.add(mesDe(pedido));
}

const esperar = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Grava numa cópia, força ir para o disco e só então troca pelo arquivo de verdade.
// No Windows, antivírus ou backup às vezes seguram o arquivo por um instante: tenta de novo.
function gravar(arq, texto) {
  const tmp = arq + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, texto);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, arq);
      return;
    } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      esperar(50 * (i + 1));
    }
  }
}

function save() {
  if (!db) return;
  fs.mkdirSync(PASTA_PEDIDOS, { recursive: true });
  // Mês atual e o anterior sempre (é onde quase tudo muda); meses mais antigos só quando marcados.
  const atual = hoje().slice(0, 7);
  const [a, m] = atual.split('-').map(Number);
  const anterior = m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, '0')}`;
  const meses = new Set([...mesesSujos, atual, anterior]);
  const grupos = new Map([...meses].map((mes) => [mes, []]));
  for (const p of db.pedidos) grupos.get(mesDe(p))?.push(p);
  // Primeiro os pedidos, depois o db.json: se faltar luz no meio, nada se perde.
  for (const [mes, lista] of grupos) {
    if (!/^\d{4}-\d{2}$/.test(mes)) continue;
    const arq = path.join(PASTA_PEDIDOS, `${mes}.json`);
    if (!lista.length && !fs.existsSync(arq)) continue;
    gravar(arq, JSON.stringify(lista));
  }
  mesesSujos.clear();
  const { pedidos, ...resto } = db;
  gravar(FILE, JSON.stringify(resto, null, 1));
}

module.exports = { load, save, marcarSujo, DATA_DIR };
