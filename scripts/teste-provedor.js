// Teste da ferramenta de conexão do Tech Provider com uma Meta simulada: node scripts/teste-provedor.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'marmita-prov-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');
process.env.PROVEDOR_CONFIG = path.join(tmp, 'provedor.json');
process.env.PROVEDOR_CLIENTES = path.join(tmp, 'clientes.json');
process.env.NODE_ENV = 'test';
fs.copyFileSync(path.join(__dirname, '..', 'config.json'), process.env.CONFIG_FILE);

const ouvir = (srv) => new Promise((r) => srv.listen(0, () => r(srv.address().port)));
const chamadas = [];
let verificacaoOk = null;

// Meta simulada
const meta = http.createServer((req, res) => {
  let d = '';
  req.on('data', (c) => (d += c));
  req.on('end', async () => {
    const u = new URL(req.url, 'http://x');
    const corpo = d ? JSON.parse(d) : null;
    chamadas.push({ metodo: req.method, caminho: u.pathname, query: Object.fromEntries(u.searchParams), corpo, auth: req.headers.authorization });
    const ok = (x) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(x)); };
    if (u.pathname === '/v25.0/oauth/access_token') {
      if (u.searchParams.get('code') !== 'COD' || u.searchParams.get('client_secret') !== 'SEGREDO') { res.writeHead(400); return res.end('{"error":{"message":"código inválido"}}'); }
      return ok({ access_token: 'TOKEN-CLIENTE' });
    }
    if (u.pathname === '/v25.0/WABA1/phone_numbers') return ok({ data: [{ id: 'PN1' }] });
    if (u.pathname === '/v25.0/PN1' && req.method === 'GET') return ok({ display_phone_number: '+55 45 99862-2219', verified_name: 'Tempero' });
    if (u.pathname === '/v25.0/WABA1/subscribed_apps') {
      if (corpo?.override_callback_uri) {
        // Como a Meta: testa o endereço novo antes de aceitar
        const v = new URL(corpo.override_callback_uri);
        v.searchParams.set('hub.mode', 'subscribe');
        v.searchParams.set('hub.verify_token', corpo.verify_token);
        v.searchParams.set('hub.challenge', '777');
        const r = await fetch(v);
        verificacaoOk = (await r.text()) === '777';
        if (!verificacaoOk) { res.writeHead(400); return res.end('{"error":{"message":"falha na verificação do webhook"}}'); }
      }
      return ok({ success: true });
    }
    if (u.pathname === '/v25.0/PN1/smb_app_data') return ok({ request_id: 'r1' });
    if (u.pathname === '/v25.0/PN1/messages') return ok({ messages: [{ id: 'x' }] });
    res.writeHead(404); res.end('{}');
  });
});

(async () => {
  const portaMeta = await ouvir(meta);
  fs.writeFileSync(process.env.PROVEDOR_CONFIG, JSON.stringify({ appId: 'APP', appSecret: 'SEGREDO', configId: 'CFG', urlApi: `http://localhost:${portaMeta}` }));
  const prov = require('../ferramentas/conectar-cliente');

  // Loja do cliente (painel + webhook)
  require('../src/config').update({ whatsapp: { urlApi: `http://localhost:${portaMeta}` } });
  const { servidor, servidorWebhook } = require('../server');
  const portaPainel = await ouvir(servidor);
  const portaWebhook = await ouvir(servidorWebhook);

  // 1. Conectar (o que acontece depois do cliente terminar a janela da Meta)
  await assert.rejects(prov.conectar({ code: 'ERRADO', wabaId: 'WABA1' }), /código inválido/);
  const r = await prov.conectar({ code: 'COD', wabaId: 'WABA1', nome: 'Tempero da Família' });
  assert.strictEqual(r.phoneNumberId, 'PN1');
  assert.strictEqual(r.token, undefined, 'token não pode ir para a tela');
  assert.ok(r.codigoConexao.startsWith('TEMPERO-'));
  assert.ok(chamadas.some((c) => c.caminho === '/v25.0/WABA1/subscribed_apps' && c.auth === 'Bearer TOKEN-CLIENTE'));

  // 2. Colar o código no painel do cliente
  const rc = await fetch(`http://localhost:${portaPainel}/api/whatsapp/codigo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codigo: r.codigoConexao }) });
  assert.strictEqual(rc.status, 200);
  const cfgCliente = require('../src/config').get().whatsapp;
  assert.strictEqual(cfgCliente.modo, 'meta');
  assert.strictEqual(cfgCliente.token, 'TOKEN-CLIENTE');

  // 3. Ativar: a Meta testa o endereço do cliente e depois puxa contatos e histórico
  const ra = await prov.ativar({ wabaId: 'WABA1', urlCliente: `http://localhost:${portaWebhook}` });
  assert.ok(verificacaoOk, 'o webhook do cliente deveria responder à verificação');
  assert.deepStrictEqual(ra.avisos, []);
  const syncs = chamadas.filter((c) => c.caminho === '/v25.0/PN1/smb_app_data').map((c) => c.corpo.sync_type);
  assert.deepStrictEqual(syncs, ['smb_app_state_sync', 'history']);

  // 4. Mensagem de cliente chegando pelo endereço ativado: o robô responde pela Meta com o token do cliente
  const ov = chamadas.find((c) => c.corpo?.override_callback_uri).corpo.override_callback_uri;
  const corpo = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: '5545911112222', profile: { name: 'Ana' } }], messages: [{ id: 'm1', from: '5545911112222', type: 'text', text: { body: 'oi' } }] } }] }] });
  const semChave = ov.replace(/\?chave=.*/, '');
  assert.strictEqual((await fetch(semChave, { method: 'POST', body: corpo })).status, 401);
  await fetch(ov, { method: 'POST', body: corpo });
  await new Promise((res) => setTimeout(res, 100));
  const envio = chamadas.find((c) => c.caminho === '/v25.0/PN1/messages');
  assert.ok(envio, 'robô deveria ter respondido');
  assert.strictEqual(envio.auth, 'Bearer TOKEN-CLIENTE');
  assert.match(envio.corpo.text.body, /Fazer pedido/);

  console.log('Ferramenta de conexão (Tech Provider): todos os testes passaram ✔');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
