const { load, save } = require('./db');
const whatsapp = require('./whatsapp');

const LIMITE_MENSAGENS = 300;

function obter(telefone, nome) {
  const db = load();
  let c = db.conversas[telefone];
  if (!c) {
    c = db.conversas[telefone] = {
      telefone,
      nome: nome || '',
      estado: 'inicio',
      rascunho: null,
      carrinho: [],
      pedidoParcial: {},
      roboPausado: false,
      mensagens: [],
      naoLidas: 0,
      atualizadoEm: new Date().toISOString(),
    };
  }
  if (nome && !c.nome) c.nome = nome;
  return c;
}

function registrar(telefone, de, texto, extra = {}) {
  const c = obter(telefone);
  c.mensagens.push({ de, texto, em: new Date().toISOString(), ...extra });
  if (c.mensagens.length > LIMITE_MENSAGENS) c.mensagens.splice(0, c.mensagens.length - LIMITE_MENSAGENS);
  if (de === 'cliente') c.naoLidas++;
  c.atualizadoEm = new Date().toISOString();
  save();
  return c;
}

// de: 'robo' | 'atendente'
async function enviar(telefone, texto, de = 'robo', extra = {}) {
  registrar(telefone, de, texto, extra);
  try {
    await whatsapp.enviar(telefone, texto);
  } catch (e) {
    registrar(telefone, 'sistema', 'Falha ao enviar: ' + e.message);
    throw e;
  }
}

// Envia o modelo aprovado pela Meta; no painel aparece o texto como o cliente vê.
async function enviarModelo(telefone, textoExibido, parametros, extra = {}) {
  registrar(telefone, 'robo', textoExibido, { modelo: true, ...extra });
  try {
    await whatsapp.enviarModelo(telefone, parametros);
  } catch (e) {
    registrar(telefone, 'sistema', 'Falha ao enviar: ' + e.message);
    throw e;
  }
}

function listar() {
  return Object.values(load().conversas)
    .map((c) => ({
      telefone: c.telefone,
      nome: c.nome,
      roboPausado: c.roboPausado,
      naoLidas: c.naoLidas,
      atualizadoEm: c.atualizadoEm,
      ultima: c.mensagens[c.mensagens.length - 1] || null,
    }))
    .sort((a, b) => b.atualizadoEm.localeCompare(a.atualizadoEm));
}

module.exports = { obter, registrar, enviar, enviarModelo, listar };
