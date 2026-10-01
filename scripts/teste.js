// Teste de ponta a ponta sem WhatsApp nem impressora: node scripts/teste.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'marmita-'));
process.env.DATA_DIR = tmp;
process.env.CONFIG_FILE = path.join(tmp, 'config.json');
process.env.NODE_ENV = 'test';
fs.copyFileSync(path.join(__dirname, '..', 'config.json'), process.env.CONFIG_FILE);

const cardapio = require('../src/cardapio');
const robo = require('../src/robo');
const pedidos = require('../src/pedidos');
const disparo = require('../src/disparo');
const { load } = require('../src/db');
const { hoje } = require('../src/util');

const TEL = '5545999990000';
const ultima = () => { const m = load().conversas[TEL].mensagens; return m[m.length - 1].texto; };
async function diz(t) { await robo.receber(TEL, 'Maria Teste', t); return ultima(); }

(async () => {
  cardapio.salvar(hoje(), cardapio.MODELOS.sabado);

  assert.match(await diz('oi'), /1\* - Fazer pedido/);
  assert.match(await diz('1'), /Qual marmita/);
  assert.match(await diz('1'), /qual tamanho/);          // Tradicional
  assert.match(await diz('2'), /Feijão/);                // M
  assert.match(await diz('1'), /adicional/);             // feijão preto
  assert.match(await diz('1,3'), /Quantas/);             // ovo + filé
  assert.match(await diz('2'), /observação/);
  assert.match(await diz('sem abobrinha'), /Seu pedido até agora/);
  assert.match(await diz('1'), /Qual marmita/);
  await diz('3'); await diz('2');                        // Kit Feijoada G
  await diz('1'); const resumo = await diz('0');         // qtd 1, sem obs
  assert.match(resumo, /Kit Feijoada G/);
  assert.match(await diz('2'), /em nome de \*Maria Teste\*/);
  assert.match(await diz('1'), /Retirar/);
  assert.match(await diz('2'), /endereço/);
  assert.match(await diz('Rua das Flores, 123, Centro'), /pagamento/);
  assert.match(await diz('2'), /troco/);
  const conf = await diz('100');
  console.log('\n--- Confirmação enviada ao cliente ---\n' + conf);
  // 2 x (20 + 3 + 8) = 62; kit G 55 => 117
  assert.match(conf, /Total: R\$ 117,00/);
  const fim = await diz('1');
  assert.match(fim, /Pedido #1 confirmado/);

  const [p] = pedidos.listar();
  assert.strictEqual(p.total, 117);
  assert.strictEqual(p.itens[0].obs, 'sem abobrinha');
  assert.ok(p.impresso, 'pedido deveria ter sido impresso');
  console.log('\n--- Cupom da cozinha ---\n' + fs.readFileSync(path.join(tmp, 'impressoes', 'pedido-1.txt'), 'utf8'));

  // Etapas do pedido: preparo, saída com entregador, entregue
  pedidos.mudarStatus(p.id, 'preparando');
  pedidos.mudarStatus(p.id, 'saiu', { entregador: 'Carlos' });
  await robo.avisarStatus(pedidos.obter(p.id));
  assert.match(ultima(), /saiu para entrega com Carlos/);
  pedidos.mudarStatus(p.id, 'entregue');
  assert.deepStrictEqual(pedidos.obter(p.id).historico.map((h) => h.status), ['novo', 'preparando', 'saiu', 'entregue']);

  // Pedido de empresa lançado no balcão, com horário de entrega
  const emp = await pedidos.criar({ origem: 'balcao', empresa: 'Mercado Bom Preço', agendadoPara: '11:30', cliente: { nome: 'Joana' },
    itens: [{ nome: 'Marmita Tradicional', tamanho: 'M', preco: 20, quantidade: 15, opcoes: { Feijão: 'Preto' }, adicionais: [] }],
    entrega: { tipo: 'entrega', endereco: 'Av. Brasil, 500' }, pagamento: { forma: 'Pix' } });
  assert.strictEqual(emp.total, 300);
  const cupomEmp = fs.readFileSync(path.join(tmp, 'impressoes', `pedido-${emp.numero}.txt`), 'utf8');
  assert.match(cupomEmp, /ENTREGAR AS 11:30/);
  assert.match(cupomEmp, /EMPRESA: MERCADO BOM/);

  // Pedido de empresa com nome e observação de cada funcionário: resumo + uma etiqueta por marmita
  const trad = (funcionario, tamanho, obs, extra = {}) => ({ nome: 'Marmita Tradicional', tamanho, preco: tamanho === 'G' ? 23 : 20, quantidade: 1, opcoes: { Feijão: 'Preto' }, adicionais: [], funcionario, obs, ...extra });
  const emp2 = await pedidos.criar({ origem: 'balcao', empresa: 'Oficina do Beto', agendadoPara: '11:45', cliente: { nome: 'Beto' },
    itens: [trad('João Silva', 'M', 'sem cebola'), trad('Maria', 'M', ''), trad('Carlos', 'G', 'pouco arroz', { adicionais: [{ nome: 'Ovo', preco: 3 }] })],
    entrega: { tipo: 'entrega', endereco: 'Rua Sete, 70' }, pagamento: { forma: 'Pix' } });
  assert.strictEqual(emp2.itens[0].funcionario, 'João Silva');
  assert.strictEqual(emp2.total, 20 + 20 + 26);
  const cupom2 = fs.readFileSync(path.join(tmp, 'impressoes', `pedido-${emp2.numero}.txt`), 'utf8');
  assert.match(cupom2, /RESUMO\n2x Marmita Tradicional M \(Preto\)\n1x Marmita Tradicional G \(Preto, \+Ovo\)/);
  assert.match(cupom2, /NOME: JOÃO SILVA/);
  assert.strictEqual((cupom2.match(/\(corte\)/g) || []).length, 3, 'uma etiqueta por marmita');
  assert.match(cupom2, /CARLOS[\s\S]*>> POUCO[\s\S]*3\/3 - entregar as 11:45/);
  const bin = fs.readFileSync(path.join(tmp, 'impressoes', `pedido-${emp2.numero}.bin`));
  assert.strictEqual(bin.toString('latin1').split('\x1dVB\x00').length - 1, 4, 'cupom + 3 etiquetas, cada um com corte');
  console.log('\n--- Pedido de empresa (cupom + etiquetas) ---\n' + cupom2);

  // Reimprimir pelo quadro: só o cupom, ou só as etiquetas (nunca as duas sem pedir)
  const impressora = require('../src/impressora');
  await pedidos.imprimir(emp2.id, { cupom: true, etiquetas: false });
  const soCupom = fs.readFileSync(path.join(tmp, 'impressoes', `pedido-${emp2.numero}-cupom.bin`)).toString('latin1');
  assert.strictEqual(soCupom.split('\x1dVB\x00').length - 1, 1, 'reimpressão do cupom sem etiquetas');
  await pedidos.imprimir(emp2.id, { cupom: false, etiquetas: true });
  const soEtiq = fs.readFileSync(path.join(tmp, 'impressoes', `pedido-${emp2.numero}-etiquetas.bin`)).toString('latin1');
  assert.strictEqual(soEtiq.split('\x1dVB\x00').length - 1, 3, 'só as 3 etiquetas');
  assert.ok(!soEtiq.includes('RESUMO'));

  // Texto colado do celular (aspas curvas, travessão, emoji) não pode virar comando da impressora
  assert.strictEqual(impressora.paraImpressora('sem “cebola” – bem passado… 😀', true), 'sem "cebola" - bem passado... ');
  const sujo = await pedidos.criar({ origem: 'balcao', cliente: { nome: 'Zé' }, empresa: 'X',
    itens: [trad('Zé', 'P', 'sem “cebola” — obrigado 🙏')], entrega: { tipo: 'balcao' }, pagamento: { forma: 'Pix' } });
  const binSujo = fs.readFileSync(path.join(tmp, 'impressoes', `pedido-${sujo.numero}.bin`));
  // Tira os comandos que o próprio sistema manda (ESC @, ESC a n, ESC E n, GS ! n, GS V B n); o resto é texto.
  const textoSujo = binSujo.toString('latin1').replace(/\x1b@|\x1b[aE][\s\S]|\x1d![\s\S]|\x1dVB[\s\S]/g, '');
  assert.ok(!/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(textoSujo), 'sem bytes de controle no texto');
  assert.match(binSujo.toString('latin1'), /SEM "CEBOLA" -\s+OBRIGADO/);

  // Quantidade absurda é limitada (e as etiquetas também)
  const grande = await pedidos.criar({ origem: 'balcao', cliente: { nome: 'Teste' }, empresa: 'Y',
    itens: [trad('Fulano', 'P', '', { quantidade: 99999 })], entrega: { tipo: 'balcao' }, pagamento: { forma: 'Pix' } });
  assert.strictEqual(grande.itens[0].quantidade, pedidos.MAX_QTD_ITEM);
  assert.ok(impressora.montarEtiquetas(grande).length <= impressora.MAX_ETIQUETAS);

  // Cardápio com ids repetidos ganha ids únicos
  const cdRep = cardapio.salvar('2026-12-01', { itens: [
    { id: 'x', nome: 'A', tamanhos: { P: 10 } }, { id: 'x', nome: 'B', tamanhos: { P: 10 } }, { nome: 'C', tamanhos: { P: 10 } },
  ] });
  assert.strictEqual(new Set(cdRep.itens.map((i) => i.id)).size, 3, 'ids únicos no cardápio');

  // Atendente
  await diz('atendente');
  assert.ok(load().conversas[TEL].roboPausado);
  const n = load().conversas[TEL].mensagens.length;
  await diz('quero trocar o pedido');
  assert.strictEqual(load().conversas[TEL].mensagens.length, n + 1, 'robô não deve responder com atendente');

  // Disparo do cardápio
  require('../src/contatos').importarTexto('João;45 99888-7777\nAna, (45) 99111-2222');
  await disparo.disparar();
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(disparo.status().historico[0].enviados, 3);
  await robo.receber('5545998887777', 'João', 'SAIR');
  assert.strictEqual(load().contatos['5545998887777'].recebeCardapio, false);

  console.log('\nTodos os testes passaram ✔');
})().catch((e) => { console.error(e); process.exit(1); });
