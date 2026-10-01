// Servidor do painel do balcão. Rodar com:  node server.js   e abrir http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./src/config');
const { load, save } = require('./src/db');
const cardapio = require('./src/cardapio');
const pedidos = require('./src/pedidos');
const contas = require('./src/contas');
const caixa = require('./src/caixa');
const conversas = require('./src/conversas');
const contatos = require('./src/contatos');
const robo = require('./src/robo');
const disparo = require('./src/disparo');
const impressora = require('./src/impressora');
const whatsapp = require('./src/whatsapp');
const { hoje, normalizarTelefone } = require('./src/util');

const PUBLIC = path.join(__dirname, 'public');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

const rotas = [];
const rota = (metodo, padrao, fn) => rotas.push({ metodo, re: new RegExp('^' + padrao.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

// ---- Cardápio
rota('GET', '/api/cardapio', ({ q }) => {
  const data = q.get('data') || hoje();
  return { data, cardapio: cardapio.obter(data), modeloSugerido: cardapio.modeloSugerido(data), modelos: cardapio.MODELOS };
});
rota('PUT', '/api/cardapio', ({ body }) => cardapio.salvar(body.data || hoje(), body));
rota('GET', '/api/cardapio/texto', ({ q }) => {
  const cd = cardapio.obter(q.get('data') || hoje());
  return { texto: cd ? cardapio.textoWhatsApp(cd) : '' };
});

// ---- Pedidos
rota('GET', '/api/pedidos', ({ q }) => pedidos.listar(q.get('data') || hoje()));
rota('POST', '/api/pedidos', ({ body }) => pedidos.criar({ ...body, origem: 'balcao' }));
rota('POST', '/api/pedidos/:id/status', async ({ p, body }) => {
  const ped = pedidos.mudarStatus(p.id, body.status, { entregador: body.entregador });
  await robo.avisarStatus(ped).catch(() => {});
  return ped;
});
rota('POST', '/api/pedidos/:id/imprimir', ({ p, body }) =>
  pedidos.imprimir(p.id, body.etiquetas ? { cupom: false, etiquetas: true } : { cupom: true, etiquetas: false })
);
rota('POST', '/api/pedidos/:id/taxa', ({ p, body }) => pedidos.definirTaxa(p.id, body.taxa));
rota('POST', '/api/pedidos/:id/pagamento', ({ p, body }) => pedidos.alterarPagamento(p.id, { forma: body.forma, contaId: body.contaId }));
rota('GET', '/api/pedidos/:id/cupom', ({ p }) => {
  const ped = pedidos.obter(p.id);
  if (!ped) throw Object.assign(new Error('Pedido não encontrado'), { status: 404 });
  return { texto: impressora.previaTexto(ped) };
});

// ---- Clientes e contas (histórico e anotado para pagar depois)
rota('GET', '/api/contas', ({ q }) => contas.listar({ busca: q.get('busca') || '', mes: q.get('mes') || undefined, abertas: q.get('abertas') === '1' }));
rota('POST', '/api/contas', ({ body }) => contas.salvar(body));
rota('GET', '/api/contas/:id/extrato', ({ p, q }) => contas.extrato(p.id, q.get('mes') || undefined));
rota('POST', '/api/contas/:id/recebimentos', ({ p, body }) => contas.receber(p.id, body));
rota('POST', '/api/contas/:id/juntar', ({ p, body }) => contas.juntar(p.id, body.destinoId));
rota('DELETE', '/api/contas/:id', ({ p }) => contas.excluir(p.id));
rota('DELETE', '/api/recebimentos/:id', ({ p }) => contas.cancelarRecebimento(p.id));

// ---- Caixa
rota('GET', '/api/caixa/mes/:mes', ({ p }) => caixa.resumoMes(p.mes));
rota('GET', '/api/caixa/:data', ({ p }) => caixa.resumo(p.data));
rota('PUT', '/api/caixa/:data/abertura', ({ p, body }) => caixa.definirAbertura(p.data, body.valor));
rota('POST', '/api/caixa/:data/sangrias', ({ p, body }) => caixa.adicionarSangria(p.data, body));
rota('DELETE', '/api/caixa/:data/sangrias/:id', ({ p }) => caixa.removerSangria(p.data, p.id));
rota('POST', '/api/caixa/:data/fechar', async ({ p, body }) => {
  const r = caixa.fechar(p.data, body);
  let erroImpressao = null;
  try { await caixa.imprimir(p.data); } catch (e) { erroImpressao = e.message; }
  return { ...r, erroImpressao };
});
rota('POST', '/api/caixa/:data/reabrir', ({ p }) => caixa.reabrir(p.data));
rota('POST', '/api/caixa/:data/imprimir', ({ p }) => caixa.imprimir(p.data));

// ---- Conversas
rota('GET', '/api/conversas', () => conversas.listar());
rota('GET', '/api/conversas/:tel', ({ p }) => {
  const c = load().conversas[p.tel];
  if (!c) throw Object.assign(new Error('Conversa não encontrada'), { status: 404 });
  return c;
});
rota('POST', '/api/conversas/:tel/lida', ({ p }) => {
  const c = load().conversas[p.tel];
  if (c) { c.naoLidas = 0; save(); }
  return { ok: true };
});
rota('POST', '/api/conversas/:tel/mensagem', async ({ p, body }) => {
  const c = conversas.obter(p.tel);
  c.roboPausado = true; // atendente respondeu: robô sai da conversa
  c.pausadoEm = new Date().toISOString();
  c.naoLidas = 0;
  await conversas.enviar(p.tel, String(body.texto || '').trim(), 'atendente');
  return c;
});
rota('POST', '/api/conversas/:tel/robo', ({ p, body }) => {
  const c = conversas.obter(p.tel);
  c.roboPausado = !body.ativo;
  if (body.ativo) Object.assign(c, { estado: 'inicio', carrinho: [], rascunho: null, pedidoParcial: {} });
  save();
  return c;
});

// ---- Contatos e envio do cardápio
rota('GET', '/api/contatos', () => contatos.listar());
rota('POST', '/api/contatos', ({ body }) => contatos.salvar(body.telefone, { nome: body.nome, endereco: body.endereco, recebeCardapio: body.recebeCardapio }));
rota('POST', '/api/contatos/importar', ({ body }) => ({ importados: contatos.importarTexto(body.texto) }));
rota('DELETE', '/api/contatos/:tel', ({ p }) => { contatos.remover(p.tel); return { ok: true }; });
rota('GET', '/api/disparo', () => disparo.status());
rota('POST', '/api/disparo', () => disparo.disparar({ origem: 'manual' }));

// ---- Configuração
rota('GET', '/api/config', () => config.get());
rota('PUT', '/api/config', ({ body }) => config.update(body));
rota('POST', '/api/impressora/teste', () =>
  impressora.imprimir({
    numero: 0, criadoEm: new Date().toISOString(), origem: 'balcao', cliente: { nome: 'TESTE DE IMPRESSÃO' },
    itens: [{ quantidade: 1, nome: 'Marmita Tradicional', tamanho: 'M', opcoes: { Feijão: 'Preto' }, adicionais: [{ nome: 'Ovo' }], obs: 'sem abobrinha' }],
    total: 23, entrega: { tipo: 'retirada' }, pagamento: { forma: 'Pix' },
  })
);

rota('POST', '/api/whatsapp/teste', async () => {
  const w = config.get().whatsapp || {};
  const token = process.env.WHATSAPP_TOKEN || w.token;
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID || w.phoneNumberId;
  if (!token || !id) throw new Error('Preencha o Phone Number ID e o token');
  const r = await fetch(`${w.urlApi || 'https://graph.facebook.com'}/${w.versaoApi || 'v25.0'}/${id}?fields=display_phone_number,verified_name`, { headers: { Authorization: `Bearer ${token}` } });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || 'Meta recusou');
  return { numero: d.display_phone_number, nome: d.verified_name };
});

// Código gerado pela ferramenta de conexão do Tech Provider (ferramentas/conectar-cliente.js).
rota('POST', '/api/whatsapp/codigo', ({ body }) => {
  const txt = String(body.codigo || '').trim().replace(/^TEMPERO-/, '');
  let d;
  try { d = JSON.parse(Buffer.from(txt, 'base64url').toString('utf8')); } catch { throw new Error('Código de conexão inválido'); }
  if (!d.phoneNumberId || !d.token || !d.verifyToken) throw new Error('Código de conexão incompleto');
  config.update({ whatsapp: { modo: 'meta', phoneNumberId: d.phoneNumberId, token: d.token, verifyToken: d.verifyToken, chaveWebhook: d.chaveWebhook || '', wabaId: d.wabaId || '', appSecret: '' } });
  return { ok: true, phoneNumberId: d.phoneNumberId };
});
rota('POST', '/api/whatsapp/webhook360', ({ body }) => whatsapp.registrarWebhook360(body.url));

// ---- Simulador (testar o robô como se fosse um cliente no WhatsApp)
rota('POST', '/api/simular', async ({ body }) => {
  const tel = normalizarTelefone(body.telefone) || '5545999990000';
  await robo.receber(tel, body.nome || 'Cliente teste', String(body.texto || ''));
  return load().conversas[tel];
});

// ---- Webhook da Meta (mensagens que os clientes mandam no WhatsApp oficial)
const idsRecebidos = new Set(); // a Meta pode reenviar a mesma mensagem; processa só uma vez

async function webhook(req, res, url) {
  if (req.method === 'GET') {
    const desafio = whatsapp.verificarWebhook(url.searchParams);
    res.writeHead(desafio ? 200 : 403, { 'Content-Type': 'text/plain' });
    return res.end(desafio || 'token de verificação inválido');
  }
  const bruto = await lerBruto(req);
  if (!whatsapp.chaveValida(url.searchParams) || !whatsapp.assinaturaValida(bruto, req.headers['x-hub-signature-256'])) {
    res.writeHead(401);
    return res.end();
  }
  res.writeHead(200); // responde logo; a Meta reenvia se demorar
  res.end();
  let corpo;
  try { corpo = JSON.parse(bruto.toString('utf8')); } catch { return; }
  for (const m of whatsapp.extrairMensagens(corpo)) {
    if (idsRecebidos.has(m.id)) continue;
    idsRecebidos.add(m.id);
    if (idsRecebidos.size > 2000) idsRecebidos.delete(idsRecebidos.values().next().value);
    try {
      if (m.eco) robo.receberEco(m.telefone, m.texto);
      else await robo.receber(m.telefone, m.nome, m.texto ?? `[${m.tipo}]`);
    } catch (e) {
      console.error('Erro ao responder', m.telefone, e.message);
    }
  }
}

function lerBruto(req) {
  return new Promise((resolve) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => resolve(Buffer.concat(partes)));
  });
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    for (const r of rotas) {
      const m = r.metodo === req.method && url.pathname.match(r.re);
      if (!m) continue;
      try {
        const body = ['POST', 'PUT'].includes(req.method) ? await lerCorpo(req) : {};
        const out = await r.fn({ p: Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)])), q: url.searchParams, body });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(out ?? null));
      } catch (e) {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ erro: e.message }));
      }
    }
    res.writeHead(404);
    return res.end('{"erro":"rota não encontrada"}');
  }
  const arq = path.join(PUBLIC, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!arq.startsWith(PUBLIC) || !fs.existsSync(arq)) { res.writeHead(404); return res.end('não encontrado'); }
  res.writeHead(200, { 'Content-Type': TIPOS[path.extname(arq)] || 'application/octet-stream' });
  fs.createReadStream(arq).pipe(res);
});

// Servidor separado, só com o /webhook. É ESTE que fica exposto na internet (pelo túnel);
// o painel e a API continuam só na rede da loja.
const servidorWebhook = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/webhook') return webhook(req, res, url);
  res.writeHead(404);
  res.end();
});

if (require.main === module) {
  load();
  contas.vincularAntigos();
  disparo.iniciarAgendador();
  const porta = process.env.PORT || config.get().porta || 3000;
  servidor.listen(porta, () => console.log(`Painel do balcão: http://localhost:${porta}`));
  const portaWebhook = process.env.PORT_WEBHOOK || config.get().portaWebhook || 3001;
  servidorWebhook.listen(portaWebhook, () => console.log(`Webhook do WhatsApp: http://localhost:${portaWebhook}/webhook (é esta porta que vai no túnel)`));
}

module.exports = { servidor, servidorWebhook };
