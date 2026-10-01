// Teste da integração com a API oficial usando uma "Meta de mentira" local: node scripts/teste-meta.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'marmita-meta-'));
process.env.DATA_DIR = tmp;
process.env.CONFIG_FILE = path.join(tmp, 'config.json');
process.env.NODE_ENV = 'test';
fs.copyFileSync(path.join(__dirname, '..', 'config.json'), process.env.CONFIG_FILE);

const recebidasMeta = [];
const metaFalsa = http.createServer((req, res) => {
  let d = '';
  req.on('data', (c) => (d += c));
  req.on('end', () => {
    recebidasMeta.push({ url: req.url, auth: req.headers.authorization, chave360: req.headers['d360-api-key'], corpo: JSON.parse(d || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages: [{ id: 'wamid.x' }] }));
  });
});

const ouvir = (srv) => new Promise((r) => srv.listen(0, () => r(srv.address().port)));
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const portaMeta = await ouvir(metaFalsa);
  const config = require('../src/config');
  config.update({ whatsapp: { modo: 'meta', urlApi: `http://localhost:${portaMeta}`, phoneNumberId: '123', token: 'TK', appSecret: 'segredo', verifyToken: 'abc' } });

  const { servidorWebhook } = require('../server');
  const cardapio = require('../src/cardapio');
  const { hoje } = require('../src/util');
  cardapio.salvar(hoje(), cardapio.MODELOS.sabado);
  const porta = await ouvir(servidorWebhook);
  const base = `http://localhost:${porta}/webhook`;

  // 1. Verificação do webhook
  let r = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=abc&hub.challenge=42`);
  assert.strictEqual(await r.text(), '42');
  r = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=42`);
  assert.strictEqual(r.status, 403);

  // 2. Mensagem do cliente
  const msg = (id, texto, tipo = 'text') => JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      contacts: [{ wa_id: '5545999990000', profile: { name: 'Maria' } }],
      messages: [{ id, from: '5545999990000', type: tipo, ...(tipo === 'text' ? { text: { body: texto } } : tipo === 'button' ? { button: { text: texto } } : {}) }],
    } }] }],
  });
  const assinar = (b) => 'sha256=' + crypto.createHmac('sha256', 'segredo').update(b).digest('hex');
  const postar = (b, assinatura = assinar(b)) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': assinatura }, body: b });

  r = await postar(msg('m0', 'oi'), 'sha256=falsa');
  assert.strictEqual(r.status, 401, 'assinatura falsa deve ser recusada');

  await postar(msg('m1', 'oi'));
  await postar(msg('m1', 'oi')); // reenvio da Meta: deve ser ignorado
  await esperar(100);
  assert.strictEqual(recebidasMeta.length, 1);
  const resp = recebidasMeta[0];
  assert.strictEqual(resp.url, '/v25.0/123/messages');
  assert.strictEqual(resp.auth, 'Bearer TK');
  assert.strictEqual(resp.corpo.to, '5545999990000');
  assert.match(resp.corpo.text.body, /Fazer pedido/);

  await postar(msg('m2', '', 'audio'));
  await esperar(100);
  assert.match(recebidasMeta[1].corpo.text.body, /áudios/);

  // 3. Cardápio da manhã vai como modelo, sem quebras de linha nos parâmetros
  require('../src/contatos').importarTexto('Ana;45991112222');
  await assert.rejects(require('../src/disparo').disparar(), /desligado para não gerar custo/);
  config.update({ disparo: { pelaApiOficial: true } });
  await require('../src/disparo').disparar();
  await esperar(100);
  const modelo = recebidasMeta.filter((x) => x.corpo.type === 'template');
  assert.strictEqual(modelo.length, 2); // Maria + Ana
  const tpl = modelo[0].corpo.template;
  assert.strictEqual(tpl.name, 'cardapio_do_dia');
  assert.strictEqual(tpl.language.code, 'pt_BR');
  for (const p of tpl.components[0].parameters) assert.ok(!/[\n\t]| {4,}/.test(p.text), 'parâmetro com quebra de linha');
  console.log('Parâmetros do modelo:\n  {{1}} = ' + tpl.components[0].parameters[0].text + '\n  {{2}} = ' + tpl.components[0].parameters[1].text);

  // 4. Cliente clica no botão "Fazer pedido" do modelo
  const antes = recebidasMeta.length;
  await postar(msg('m3', 'Fazer pedido', 'button'));
  await esperar(100);
  assert.match(recebidasMeta[antes].corpo.text.body, /Qual marmita/);

  // 5. Coexistência pelo 360dialog
  config.update({ whatsapp: { modo: 'dialog360', url360: `http://localhost:${portaMeta}`, apiKey360: 'K360', chaveWebhook: 'segredo360' } });
  const post360 = (b, chave) => fetch(`${base}${chave ? '?chave=' + chave : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b });
  const TEL2 = '5545977776666';
  const msg2 = (id, texto) => JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: TEL2, profile: { name: 'Zé' } }], messages: [{ id, from: TEL2, type: 'text', text: { body: texto } }] } }] }] });
  assert.strictEqual((await post360(msg2('d0', 'oi'))).status, 401, 'sem a chave deve recusar');
  let n0 = recebidasMeta.length;
  await post360(msg2('d1', 'oi'), 'segredo360');
  await esperar(100);
  const r360 = recebidasMeta[n0];
  assert.strictEqual(r360.url, '/messages');
  assert.strictEqual(r360.chave360, 'K360');
  assert.match(r360.corpo.text.body, /Fazer pedido/);

  // Alguém responde pelo celular (eco): aparece no painel e o robô para de responder esse cliente
  const eco = JSON.stringify({ entry: [{ changes: [{ field: 'smb_message_echoes', value: { message_echoes: [{ id: 'e1', from: '5545998622219', to: TEL2, type: 'text', text: { body: 'Oi Zé, aqui é a Dona Maria!' } }] } }] }] });
  await post360(eco, 'segredo360');
  await esperar(100);
  const { load } = require('../src/db');
  const conv = load().conversas[TEL2];
  assert.ok(conv.roboPausado);
  assert.strictEqual(conv.mensagens.at(-1).de, 'atendente');
  n0 = recebidasMeta.length;
  await post360(msg2('d2', 'quero 2 marmitas'), 'segredo360');
  await esperar(100);
  assert.strictEqual(recebidasMeta.length, n0, 'robô não deve responder depois que o celular assumiu');

  console.log('\nIntegração com a API oficial: todos os testes passaram ✔');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
