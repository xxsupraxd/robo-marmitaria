const { load, save } = require('./db');
const { normalizarTelefone } = require('./util');

function obter(telefone) {
  return load().contatos[telefone] || null;
}

function salvar(telefone, dados = {}) {
  const db = load();
  const tel = normalizarTelefone(telefone);
  if (!tel) return null;
  const atual = db.contatos[tel] || { telefone: tel, nome: '', endereco: '', recebeCardapio: true, criadoEm: new Date().toISOString() };
  for (const [k, v] of Object.entries(dados)) if (v !== undefined && v !== '') atual[k] = v;
  db.contatos[tel] = atual;
  save();
  return atual;
}

function listar() {
  return Object.values(load().contatos).sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
}

function remover(telefone) {
  delete load().contatos[telefone];
  save();
}

// Aceita uma linha por contato: "Nome;telefone", "Nome, telefone", "telefone" ou o CSV exportado do celular.
function importarTexto(texto) {
  let n = 0;
  for (const linha of String(texto).split(/\r?\n/)) {
    const tel = (linha.match(/\+?\d[\d\s().-]{8,}\d/) || [])[0];
    if (!tel) continue;
    const nome = linha.replace(tel, '').replace(/[;,\t"]/g, ' ').trim();
    if (salvar(tel, { nome })) n++;
  }
  return n;
}

module.exports = { obter, salvar, listar, remover, importarTexto };
