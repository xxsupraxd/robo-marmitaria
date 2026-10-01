// Ferramenta do Tech Provider (Wellington): conecta o WhatsApp Business de um cliente ao robô,
// no mesmo número (coexistência), pelo Cadastro Incorporado (Embedded Signup) da Meta.
// Roda no SEU computador, não no do cliente: aqui fica a chave secreta do seu app da Meta.
//
//   node ferramentas/conectar-cliente.js     e abrir http://localhost:4000
//
// Configuração em ferramentas/provedor.json (criado na primeira vez; não compartilhe esse arquivo).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;
const ARQ_CONFIG = process.env.PROVEDOR_CONFIG || path.join(DIR, 'provedor.json');
const ARQ_CLIENTES = process.env.PROVEDOR_CLIENTES || path.join(DIR, 'clientes.json');

const PADRAO = {
  appId: '',
  appSecret: '',
  configId: '',
  versaoApi: 'v25.0',
  urlApi: 'https://graph.facebook.com',
  featureType: 'whatsapp_business_app_onboarding',
  porta: 4000,
};

function lerJson(arq, padrao) {
  try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return padrao; }
}
function gravarJson(arq, dados) {
  fs.writeFileSync(arq, JSON.stringify(dados, null, 2) + '\n');
}
if (!fs.existsSync(ARQ_CONFIG)) gravarJson(ARQ_CONFIG, PADRAO);
const cfg = () => ({ ...PADRAO, ...lerJson(ARQ_CONFIG, {}) });
const clientes = () => lerJson(ARQ_CLIENTES, {});

async function graph(metodo, caminho, { token, corpo, query } = {}) {
  const c = cfg();
  const url = new URL(`${c.urlApi}/${c.versaoApi}/${caminho}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const r = await fetch(url, {
    method: metodo,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${caminho}: ${d.error?.message || r.status}`);
  return d;
}

// Passo 1: logo depois do cliente terminar o cadastro na janela da Meta.
// O código vale só 30 segundos, por isso a troca é feita na hora.
async function conectar({ code, wabaId, phoneNumberId, nome }) {
  const c = cfg();
  if (!c.appId || !c.appSecret) throw new Error('Preencha appId e appSecret em ferramentas/provedor.json');
  if (!code || !wabaId) throw new Error('A Meta não devolveu o código ou a conta do WhatsApp');
  const { access_token: token } = await graph('GET', 'oauth/access_token', { query: { client_id: c.appId, client_secret: c.appSecret, code } });
  if (!phoneNumberId) {
    const nums = await graph('GET', `${wabaId}/phone_numbers`, { token });
    phoneNumberId = nums.data?.[0]?.id;
    if (!phoneNumberId) throw new Error('Nenhum número encontrado na conta do cliente');
  }
  // Inscreve o seu app para receber as mensagens desse cliente.
  await graph('POST', `${wabaId}/subscribed_apps`, { token });
  let numero = '';
  try { numero = (await graph('GET', phoneNumberId, { token, query: { fields: 'display_phone_number,verified_name' } })).display_phone_number; } catch {}

  const cliente = {
    nome: nome || numero || wabaId,
    wabaId,
    phoneNumberId,
    numero,
    token,
    verifyToken: crypto.randomBytes(9).toString('hex'),
    chaveWebhook: crypto.randomBytes(12).toString('hex'),
    conectadoEm: new Date().toISOString(),
    webhookAtivo: false,
  };
  const todos = clientes();
  todos[wabaId] = cliente;
  gravarJson(ARQ_CLIENTES, todos);
  return { ...publico(cliente), codigoConexao: codigoConexao(cliente) };
}

// Texto que se cola no painel do cliente (Configurações > WhatsApp > Código de conexão).
function codigoConexao(c) {
  const dados = { modo: 'meta', phoneNumberId: c.phoneNumberId, token: c.token, verifyToken: c.verifyToken, chaveWebhook: c.chaveWebhook, wabaId: c.wabaId };
  return 'TEMPERO-' + Buffer.from(JSON.stringify(dados)).toString('base64url');
}

// Passo 2: com o painel do cliente configurado e o túnel dele no ar,
// aponta as mensagens desse cliente para o computador dele e puxa contatos e histórico.
async function ativar({ wabaId, urlCliente }) {
  const todos = clientes();
  const c = todos[wabaId];
  if (!c) throw new Error('Cliente não encontrado');
  const base = String(urlCliente || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(base + '/')) throw new Error('O endereço do cliente precisa começar com https://');
  const url = `${base}/webhook?chave=${c.chaveWebhook}`;
  if (url.length > 200) throw new Error('Endereço muito longo (a Meta aceita até 200 caracteres)');
  await graph('POST', `${wabaId}/subscribed_apps`, { token: c.token, corpo: { override_callback_uri: url, verify_token: c.verifyToken } });
  const avisos = [];
  // A Meta só permite puxar contatos e histórico nas primeiras 24 horas depois da conexão.
  for (const sync_type of ['smb_app_state_sync', 'history']) {
    try { await graph('POST', `${c.phoneNumberId}/smb_app_data`, { token: c.token, corpo: { messaging_product: 'whatsapp', sync_type } }); }
    catch (e) { avisos.push(e.message); }
  }
  Object.assign(c, { urlCliente: base, webhookAtivo: true, ativadoEm: new Date().toISOString() });
  gravarJson(ARQ_CLIENTES, todos);
  return { ...publico(c), avisos };
}

// Nunca manda o token para a tela, só o necessário.
function publico(c) {
  const { token, ...resto } = c;
  return resto;
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (x) => (d += x));
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (status, dados) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(dados)); };
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(DIR, 'conectar-cliente.html')));
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      const c = cfg();
      return json(200, { appId: c.appId, configId: c.configId, versaoApi: c.versaoApi, featureType: c.featureType, pronto: !!(c.appId && c.appSecret && c.configId) });
    }
    if (req.method === 'GET' && url.pathname === '/api/clientes') return json(200, Object.values(clientes()).map(publico));
    if (req.method === 'GET' && url.pathname === '/api/codigo') {
      const c = clientes()[url.searchParams.get('waba')];
      if (!c) return json(404, { erro: 'Cliente não encontrado' });
      return json(200, { codigoConexao: codigoConexao(c) });
    }
    if (req.method === 'POST' && url.pathname === '/api/conectar') return json(200, await conectar(await lerCorpo(req)));
    if (req.method === 'POST' && url.pathname === '/api/ativar') return json(200, await ativar(await lerCorpo(req)));
    json(404, { erro: 'não encontrado' });
  } catch (e) {
    json(400, { erro: e.message });
  }
});

if (require.main === module) {
  // Só no próprio computador: esta ferramenta guarda os tokens dos clientes.
  servidor.listen(cfg().porta, '127.0.0.1', () => console.log(`Conectar clientes: http://localhost:${cfg().porta}`));
}

module.exports = { servidor, conectar, ativar, codigoConexao };
