// Teste do fechamento de caixa, das contas de clientes (anotado / pagar depois) e do extrato mensal.
//   node scripts/teste-caixa.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'marmita-caixa-'));
process.env.DATA_DIR = tmp;
process.env.CONFIG_FILE = path.join(tmp, 'config.json');
fs.copyFileSync(path.join(__dirname, '..', 'config.json'), process.env.CONFIG_FILE);

const db = require('../src/db');
const cardapio = require('../src/cardapio');
const pedidos = require('../src/pedidos');
const contas = require('../src/contas');
const caixa = require('../src/caixa');
const robo = require('../src/robo');
const { hoje } = require('../src/util');

const HOJE = hoje();
const MES = HOJE.slice(0, 7);
const marmita = (preco, extra = {}) => ({ nome: 'Marmita Tradicional', tamanho: 'M', preco, quantidade: 1, opcoes: { Feijão: 'Preto' }, adicionais: [], ...extra });
const balcao = (dados) => pedidos.criar({ origem: 'balcao', entrega: { tipo: 'balcao' }, ...dados });

(async () => {
  // ---- Vendas do dia
  const p1 = await balcao({ cliente: { nome: 'Ana' }, itens: [marmita(20)], pagamento: { forma: 'Dinheiro' } });
  const p2 = await balcao({ cliente: { nome: 'Bruno' }, itens: [marmita(23)], pagamento: { forma: 'Pix' } });
  const p3 = await balcao({ cliente: { nome: 'Caio' }, itens: [marmita(17)], pagamento: { forma: 'Cartão' } });
  const emp = await balcao({ empresa: 'Mercado Bom Preço', cliente: { nome: '' }, pagamento: { forma: 'Anotado' },
    itens: [marmita(20, { funcionario: 'João' }), marmita(20, { funcionario: 'joão ', adicionais: [{ nome: 'Ovo', preco: 3 }] }), marmita(23, { funcionario: 'Maria', quantidade: 2 })] });
  const fiado = await balcao({ cliente: { nome: 'Dona Rosa' }, itens: [marmita(20)], pagamento: { forma: 'Anotado' } });
  const cancelado = await balcao({ cliente: { nome: 'Edu' }, itens: [marmita(20)], pagamento: { forma: 'Dinheiro' } });
  pedidos.mudarStatus(cancelado.id, 'cancelado');
  const pendente = await balcao({ cliente: { nome: 'Fabi' }, itens: [marmita(20)], pagamento: { forma: 'Dinheiro' } });
  for (const p of [p1, p2, p3, emp, fiado]) pedidos.mudarStatus(p.id, 'entregue');

  // Contas: empresa e "Dona Rosa" ganharam conta; quem pagou na hora sem telefone, não.
  assert.ok(emp.contaId && fiado.contaId);
  assert.strictEqual(p1.contaId, null);
  assert.strictEqual(contas.obter(emp.contaId).tipo, 'empresa');
  // Mesma empresa escrita diferente cai na mesma conta.
  const emp2 = await balcao({ empresa: '  mercado bom preco ', itens: [marmita(20, { funcionario: 'Carlos' })], pagamento: { forma: 'Anotado' } });
  assert.strictEqual(emp2.contaId, emp.contaId);
  pedidos.mudarStatus(emp2.id, 'entregue');
  // Anotar sem nome nenhum não pode.
  await assert.rejects(balcao({ cliente: { nome: '' }, itens: [marmita(20)], pagamento: { forma: 'Anotado' } }), /nome/);
  await assert.rejects(balcao({ cliente: { nome: 'X' }, itens: [marmita(20)], pagamento: { forma: 'Cheque' } }), /inválida/);

  // ---- Fechamento
  caixa.definirAbertura(HOJE, '50');
  caixa.adicionarSangria(HOJE, { valor: 15, descricao: 'Gás' });
  let r = caixa.resumo(HOJE);
  const totalEmp = 20 + 23 + 46; // João 20, João+ovo 23, Maria 2x23
  assert.strictEqual(r.vendido, 20 + 23 + 17 + totalEmp + 20 + 20 + 20, 'vendido = tudo menos cancelado');
  assert.strictEqual(r.recebidoVendas.Dinheiro, 20);
  assert.strictEqual(r.recebidoVendas.Pix, 23);
  assert.strictEqual(r.recebidoVendas['Cartão'], 17);
  assert.strictEqual(r.anotado, totalEmp + 20 + 20);
  assert.strictEqual(r.pendente, 20);
  assert.strictEqual(r.vendido, r.recebidoVendas.total + r.anotado + r.pendente, 'vendido = recebido + anotado + pendente');
  assert.deepStrictEqual(r.cancelados, { qtd: 1, valor: 20 });
  assert.strictEqual(r.gaveta.esperado, 50 + 20 - 15);
  assert.strictEqual(r.anotadoPorConta[0].nome, 'Mercado Bom Preço');
  assert.strictEqual(r.pendentes[0].numero, pendente.numero);

  // Pagamento de conta anotada entra no caixa do dia.
  contas.receber(fiado.contaId, { valor: '20,00', forma: 'Dinheiro', obs: 'acertou' });
  r = caixa.resumo(HOJE);
  assert.strictEqual(r.recebidoContas.Dinheiro, 20);
  assert.strictEqual(r.entrou.total, 20 + 23 + 17 + 20);
  assert.strictEqual(r.gaveta.esperado, 50 + 40 - 15);
  assert.throws(() => contas.receber(fiado.contaId, { valor: 0, forma: 'Pix' }), /Valor/);
  assert.throws(() => contas.receber(fiado.contaId, { valor: 10, forma: 'Anotado' }), /forma/);

  // Corrigir a forma: o Pix virou dinheiro.
  pedidos.alterarPagamento(p2.id, { forma: 'Dinheiro' });
  r = caixa.resumo(HOJE);
  assert.strictEqual(r.recebidoVendas.Dinheiro, 43);
  assert.strictEqual(r.recebidoVendas.Pix, 0);

  // Fechar: contou 97 na gaveta (deveria ter 98) -> faltou 1.
  r = caixa.fechar(HOJE, { contado: '97' });
  assert.strictEqual(r.fechamento.diferenca, -1);
  assert.strictEqual(r.mudouDepois, false);
  assert.throws(() => caixa.fechar(HOJE, { contado: '' }), /gaveta/);
  await caixa.imprimir(HOJE);
  const papel = fs.readFileSync(path.join(tmp, 'impressoes', `caixa-${HOJE}.txt`), 'utf8');
  assert.match(papel, /FECHAMENTO DE CAIXA/);
  assert.match(papel, /FALTOU\s+R\$ 1,00/);
  assert.match(papel, /Mercado Bom Preço\s+R\$ 1[0-9]{2},00/);
  for (const l of papel.split('\n')) assert.ok(l.length <= 48, 'linha maior que o papel: ' + l);
  // Algo mudou depois de fechar: avisa.
  pedidos.mudarStatus(pendente.id, 'entregue');
  assert.strictEqual(caixa.resumo(HOJE).mudouDepois, true);

  // ---- Conta e extrato do mês
  let ex = contas.extrato(emp.contaId, MES);
  assert.strictEqual(ex.totais.pedidos, 2);
  assert.strictEqual(ex.totais.anotado, totalEmp + 20);
  assert.strictEqual(ex.saldoFinal, totalEmp + 20);
  const joao = ex.porFuncionario.find((f) => f.nome === 'João');
  assert.deepStrictEqual({ marmitas: joao.marmitas, valor: joao.valor }, { marmitas: 2, valor: 43 }, 'João junta com "joão "');
  assert.strictEqual(ex.porFuncionario.find((f) => f.nome === 'Maria').marmitas, 2);
  contas.receber(emp.contaId, { valor: 100, forma: 'Pix' });
  ex = contas.extrato(emp.contaId, MES);
  assert.strictEqual(ex.saldoFinal, totalEmp + 20 - 100);
  assert.strictEqual(ex.saldoHoje, totalEmp + 20 - 100);
  // Mês seguinte começa com o saldo que ficou.
  const [a, m] = MES.split('-').map(Number);
  const prox = m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`;
  assert.strictEqual(contas.extrato(emp.contaId, prox).saldoAnterior, totalEmp + 20 - 100);
  // Pagamento lançado errado é cancelado e sai do saldo.
  const errado = contas.receber(emp.contaId, { valor: 5, forma: 'Dinheiro' });
  contas.cancelarRecebimento(errado.id);
  assert.strictEqual(contas.extrato(emp.contaId, MES).saldoHoje, totalEmp + 20 - 100);

  // Lista de clientes: quem deve aparece primeiro.
  const lista = contas.listar({ mes: MES });
  assert.strictEqual(lista[0].id, emp.contaId);
  assert.strictEqual(contas.listar({ abertas: true }).length, 1, 'Dona Rosa já pagou');
  assert.strictEqual(contas.listar({ busca: 'rosa' })[0].nome, 'Dona Rosa');

  // Cadastro: empresa repetida não pode; juntar cadastros repetidos.
  assert.throws(() => contas.salvar({ tipo: 'empresa', nome: 'MERCADO BOM PREÇO' }), /Já existe/);
  const rosa2 = contas.salvar({ tipo: 'pessoa', nome: 'Rosa', telefone: '(45) 99911-2233' });
  contas.juntar(rosa2.id, fiado.contaId);
  assert.strictEqual(contas.obter(rosa2.id), null);
  assert.strictEqual(contas.obter(fiado.contaId).telefone, '5545999112233');
  assert.throws(() => contas.excluir(fiado.contaId), /pedidos/);

  // ---- Robô: "anotar na minha conta" só para quem a loja liberou
  cardapio.salvar(HOJE, cardapio.MODELOS['dia-comum']);
  const TEL = '5545988887777';
  const ultima = () => { const ms = db.load().conversas[TEL].mensagens; return ms[ms.length - 1].texto; };
  const diz = async (t) => { await robo.receber(TEL, 'Zeca', t); return ultima(); };
  const pedirAtePagamento = async () => {
    await diz('oi'); await diz('1'); await diz('1'); await diz('2'); await diz('1'); await diz('0'); await diz('1'); await diz('0');
    await diz('2'); await diz('Zeca'); return diz('1');
  };
  assert.doesNotMatch(await pedirAtePagamento(), /Anotar/);
  assert.match(await diz('4'), /Opção inválida/);
  await diz('1'); await diz('1'); // Pix, confirma: abre a conta do Zeca pelo telefone
  const contaZeca = contas.porTelefone(TEL);
  assert.ok(contaZeca);
  contas.salvar({ id: contaZeca.id, anotar: true });
  assert.match(await pedirAtePagamento(), /4\* - Anotar na minha conta/);
  assert.match(await diz('4'), /Anotar na sua conta/);
  assert.match(await diz('1'), /confirmado/);
  const doZeca = db.load().pedidos.filter((p) => p.contaId === contaZeca.id);
  assert.strictEqual(doZeca.length, 2);
  assert.strictEqual(doZeca[1].pagamento.forma, 'Anotado');
  // Pelo WhatsApp, sem liberação, o servidor recusa mesmo que alguém tente.
  contas.salvar({ id: contaZeca.id, anotar: false });
  await assert.rejects(pedidos.criar({ origem: 'whatsapp', cliente: { nome: 'Zeca', telefone: TEL }, itens: [marmita(20)], pagamento: { forma: 'Anotado' } }), /liberado/);

  // ---- Resumo do mês
  const mes = caixa.resumoMes(MES);
  assert.strictEqual(mes.dias.length, 1);
  assert.strictEqual(mes.total.vendido, caixa.resumo(HOJE).vendido);
  assert.strictEqual(mes.dias[0].fechado, true);

  // ---- Pedidos gravados um arquivo por mês, e lidos de volta
  db.save();
  const arq = path.join(tmp, 'pedidos', `${MES}.json`);
  assert.ok(fs.existsSync(arq));
  assert.strictEqual(JSON.parse(fs.readFileSync(arq, 'utf8')).length, db.load().pedidos.length);
  assert.ok(!('pedidos' in JSON.parse(fs.readFileSync(path.join(tmp, 'db.json'), 'utf8'))), 'db.json sem os pedidos');
  // Formato antigo (todos os pedidos dentro do db.json) é convertido sozinho.
  const antigo = fs.mkdtempSync(path.join(os.tmpdir(), 'marmita-antigo-'));
  fs.writeFileSync(path.join(antigo, 'db.json'), JSON.stringify({ seqPedido: 2, pedidos: [
    { id: 1, numero: 1, data: '2026-08-10', criadoEm: '2026-08-10T15:00:00Z', origem: 'balcao', cliente: { nome: 'Velho', telefone: '45999001122' }, itens: [], total: 20, status: 'entregue', pagamento: { forma: 'Dinheiro' } },
    { id: 2, numero: 1, data: '2026-09-02', criadoEm: '2026-09-02T15:00:00Z', origem: 'balcao', empresa: 'Oficina', cliente: { nome: '' }, itens: [], total: 40, status: 'entregue', pagamento: { forma: 'Anotado' } },
  ] }));

  const saida = execFileSync(process.execPath, ['-e', `
    const db = require('./src/db'); const contas = require('./src/contas');
    db.load(); const n = contas.vincularAntigos(); db.save();
    const of = Object.values(db.load().contas).find((c) => c.nome === 'Oficina');
    console.log(JSON.stringify({ n, saldo: contas.saldos().get(of.id).saldo }));
  `], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: antigo } }).toString();
  assert.deepStrictEqual(JSON.parse(saida), { n: 2, saldo: 40 });
  assert.ok(fs.existsSync(path.join(antigo, 'pedidos', '2026-08.json')) && fs.existsSync(path.join(antigo, 'pedidos', '2026-09.json')));
  assert.ok(!('pedidos' in JSON.parse(fs.readFileSync(path.join(antigo, 'db.json'), 'utf8'))));

  // ---- Correções da revisão
  // Telefone de quem pediu para a empresa não vira telefone da empresa; pedido pessoal fica na conta da pessoa.
  const pedEmp = await balcao({ empresa: 'Oficina do Beto', cliente: { nome: 'Carla', telefone: '45999334455' }, itens: [marmita(20)], pagamento: { forma: 'Anotado' } });
  assert.strictEqual(contas.obter(pedEmp.contaId).telefone, '');
  assert.strictEqual(contas.porTelefone('5545999334455'), null);
  const pessoal = await pedidos.criar({ origem: 'whatsapp', cliente: { nome: 'Carla', telefone: '5545999334455' }, itens: [marmita(20)], entrega: { tipo: 'retirada' }, pagamento: { forma: 'Pix' } });
  assert.notStrictEqual(pessoal.contaId, pedEmp.contaId);
  // Celular sem o 9 (como o WhatsApp às vezes manda) é o mesmo cliente.
  assert.strictEqual(contas.porTelefone('554599334455').id, pessoal.contaId);
  // Dois "Paulo": anotar só pelo nome não escolhe nenhum; com a conta escolhida, vai certo.
  const paulo1 = contas.salvar({ nome: 'Paulo', telefone: '45999000001' });
  const paulo2 = contas.salvar({ nome: 'Paulo', telefone: '45999000002' });
  await assert.rejects(balcao({ cliente: { nome: 'paulo' }, itens: [marmita(20)], pagamento: { forma: 'Anotado' } }), /mais de um cliente/);
  const pauloPago = await balcao({ cliente: { nome: 'Paulo' }, itens: [marmita(20)], pagamento: { forma: 'Dinheiro' } });
  assert.throws(() => pedidos.alterarPagamento(pauloPago.id, { forma: 'Anotado' }), /mais de um cliente/);
  pedidos.alterarPagamento(pauloPago.id, { forma: 'Anotado', contaId: paulo2.id });
  assert.strictEqual(contas.saldos().get(paulo2.id).saldo, 20);
  assert.strictEqual(contas.saldos().get(paulo1.id), undefined);
  // Mudar só a conta de um pedido já anotado também grava.
  pedidos.alterarPagamento(pauloPago.id, { forma: 'Anotado', contaId: paulo1.id });
  assert.strictEqual(contas.saldos().get(paulo1.id).saldo, 20);
  // Juntar guarda o telefone das duas contas.
  contas.juntar(paulo2.id, paulo1.id);
  assert.strictEqual(contas.porTelefone('45999000002').id, paulo1.id);
  // Excluir conta que só tem pedido cancelado.
  const teste = await balcao({ cliente: { nome: 'Teste Apagar', telefone: '45999777666' }, itens: [marmita(20)], pagamento: { forma: 'Pix' } });
  pedidos.mudarStatus(teste.id, 'cancelado');
  contas.excluir(teste.contaId);
  assert.strictEqual(contas.obter(teste.contaId), null);

  // Taxa de entrega "a confirmar" informada depois entra no total e na conta.
  const entrega = await balcao({ empresa: 'Oficina do Beto', itens: [marmita(20)], entrega: { tipo: 'entrega', endereco: 'Rua 1' }, pagamento: { forma: 'Anotado' } });
  assert.strictEqual(entrega.entrega.taxa, null);
  assert.ok(caixa.resumo(HOJE).taxaAConfirmar.some((x) => x.id === entrega.id));
  const saldoAntes = contas.saldos().get(entrega.contaId).saldo;
  pedidos.definirTaxa(entrega.id, '5,50');
  assert.strictEqual(pedidos.obter(entrega.id).total, 25.5);
  assert.strictEqual(contas.saldos().get(entrega.contaId).saldo, saldoAntes + 5.5);
  assert.ok(!caixa.resumo(HOJE).taxaAConfirmar.some((x) => x.id === entrega.id));
  await assert.rejects(balcao({ cliente: { nome: 'X' }, itens: [marmita(20)], entrega: { tipo: 'entrega', taxa: 'abc' }, pagamento: { forma: 'Pix' } }), /Taxa/);
  const comTaxa = await balcao({ cliente: { nome: 'Y' }, itens: [marmita(20)], entrega: { tipo: 'entrega', endereco: 'Rua 2', taxa: '4' }, pagamento: { forma: 'Pix' } });
  assert.strictEqual(comTaxa.total, 24);

  // Extrato: pedido pago na hora mas ainda não entregue não conta como pago.
  const ex2 = contas.extrato(pessoal.contaId, MES);
  assert.strictEqual(ex2.totais.pagoNaHora, 0);
  assert.strictEqual(ex2.totais.naoFinalizado, 20);
  assert.match(ex2.texto, /não finalizado/);

  // Fechamento: Pix -> Cartão depois de fechar também avisa; cupom e mês usam a diferença de agora.
  caixa.fechar(HOJE, { contado: caixa.resumo(HOJE).gaveta.esperado });
  assert.strictEqual(caixa.resumo(HOJE).mudouDepois, false);
  const pixEntregue = await balcao({ cliente: { nome: 'Pix Teste' }, itens: [marmita(20)], pagamento: { forma: 'Pix' } });
  pedidos.mudarStatus(pixEntregue.id, 'entregue');
  caixa.fechar(HOJE, { contado: caixa.resumo(HOJE).gaveta.esperado });
  pedidos.alterarPagamento(pixEntregue.id, { forma: 'Cartão' });
  assert.strictEqual(caixa.resumo(HOJE).mudouDepois, true, 'Pix virou Cartão');
  pedidos.alterarPagamento(pixEntregue.id, { forma: 'Dinheiro' });
  const textoCupom = require('../src/impressora').textoFolhas([caixa.montarCupom(caixa.resumo(HOJE))]);
  assert.match(textoCupom, /ATENCAO: mudou depois/);
  assert.match(textoCupom, /SOBROU|FALTOU/);
  assert.doesNotMatch(textoCupom, /sem diferenca/);
  assert.strictEqual(caixa.resumoMes(MES).dias[0].mudouDepois, true);
  assert.strictEqual(caixa.resumoMes(MES).dias[0].diferenca, -20);

  // Valores e datas inválidos não viram zero.
  assert.throws(() => caixa.definirAbertura(HOJE, 'abc'), /inválido/);
  assert.throws(() => caixa.adicionarSangria(HOJE, { valor: 'dez' }), /inválido/);
  assert.throws(() => caixa.resumo('2026-02-30'), /Data/);
  assert.throws(() => contas.receber(paulo1.id, { valor: '1e3', forma: 'Pix' }), /Valor/);

  // Linha do fechamento com "…" no nome não passa da largura do papel.
  const longo = await balcao({ cliente: { nome: 'Nome comprido com reticências……………… e mais' }, itens: [marmita(20)], pagamento: { forma: 'Anotado' } });
  const papel2 = require('../src/impressora').textoFolhas([caixa.montarCupom(caixa.resumo(HOJE))]);
  for (const l of papel2.split('\n')) assert.ok(l.length <= 48, 'linha maior que o papel: ' + l);
  pedidos.mudarStatus(longo.id, 'cancelado');

  // Queda de luz entre gravar pedidos e db.json: conta perdida é recriada e o número não se repete.
  const queda = fs.mkdtempSync(path.join(os.tmpdir(), 'marmita-queda-'));
  fs.mkdirSync(path.join(queda, 'pedidos'));
  fs.writeFileSync(path.join(queda, 'pedidos', '2026-09.json'), JSON.stringify([{ id: 5, numero: 1, data: '2026-09-01', criadoEm: '2026-09-01T15:00:00Z', origem: 'balcao', cliente: { nome: 'Z' }, itens: [], total: 30, status: 'entregue', pagamento: { forma: 'Anotado' }, contaId: 3 }]));
  fs.writeFileSync(path.join(queda, 'db.json'), JSON.stringify({ seqConta: 1, contas: { 1: { id: 1, tipo: 'pessoa', nome: 'A', telefone: '' } } }));
  const saida2 = execFileSync(process.execPath, ['-e', `
    const db = require('./src/db'); const contas = require('./src/contas');
    const d = db.load(); const nova = contas.salvar({ nome: 'Nova' });
    console.log(JSON.stringify({ seqPedido: d.seqPedido, recuperada: d.contas[3].nome, nova: nova.id }));
  `], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: queda } }).toString();
  assert.deepStrictEqual(JSON.parse(saida2), { seqPedido: 5, recuperada: 'Conta recuperada #3', nova: 4 });

  console.log('Caixa, contas e extrato: todos os testes passaram ✔');
})().catch((e) => { console.error(e); process.exit(1); });
