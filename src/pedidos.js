const { load, save, marcarSujo } = require('./db');
const { hoje, reais } = require('./util');
const config = require('./config');
const impressora = require('./impressora');
const contas = require('./contas');

const STATUS = ['novo', 'preparando', 'pronto', 'saiu', 'entregue', 'cancelado'];
// "Anotado" = o cliente paga depois; o valor vai para a conta dele (fechamento do mês).
const FORMAS_PAGAMENTO = ['Dinheiro', 'Pix', 'Cartão', contas.ANOTADO];

// Teto por linha do pedido: evita imprimir rolos de etiquetas (ou travar o sistema) por um número digitado errado.
const MAX_QTD_ITEM = 200;

function calcularItem(it) {
  const adicionais = it.adicionais || [];
  const precoUnit = Number(it.preco) + adicionais.reduce((s, a) => s + Number(a.preco || 0), 0);
  const quantidade = Math.min(MAX_QTD_ITEM, Math.max(1, parseInt(it.quantidade, 10) || 1));
  const funcionario = String(it.funcionario || '').trim().slice(0, 60);
  return { ...it, funcionario, quantidade, adicionais, precoUnit, total: precoUnit * quantidade };
}

async function criar(dados) {
  const db = load();
  const itens = (dados.itens || []).map(calcularItem);
  if (!itens.length) throw new Error('Pedido sem itens');
  const taxa = dados.entrega?.tipo === 'entrega' ? lerTaxa(dados.entrega.taxa ?? config.get().taxaEntrega) : null;
  const pagamento = { ...(dados.pagamento || {}), forma: dados.pagamento?.forma || 'Dinheiro' };
  if (!FORMAS_PAGAMENTO.includes(pagamento.forma)) throw new Error('Forma de pagamento inválida');
  const anotar = pagamento.forma === contas.ANOTADO;
  // Pelo WhatsApp só anota quem a loja liberou na conta; no balcão a atendente decide.
  if (anotar && dados.origem === 'whatsapp' && !contas.porTelefone(dados.cliente?.telefone)?.anotar) throw new Error('Este cliente não está liberado para anotar');
  const conta = contas.resolver({ contaId: dados.contaId, empresa: dados.empresa, nome: dados.cliente?.nome, telefone: dados.cliente?.telefone, anotar });
  if (anotar && !conta) throw new Error(erroSemConta(dados.cliente?.nome));
  const pedido = {
    id: ++db.seqPedido,
    numero: numeroDoDia(db),
    data: hoje(),
    criadoEm: new Date().toISOString(),
    origem: dados.origem || 'balcao',
    cliente: { nome: dados.cliente?.nome || '', telefone: dados.cliente?.telefone || '' },
    itens,
    obs: dados.obs || '',
    entrega: dados.entrega ? { ...dados.entrega, taxa } : null,
    pagamento,
    contaId: conta ? conta.id : null,
    total: contas.r2(itens.reduce((s, i) => s + i.total, 0) + (taxa || 0)),
    status: 'novo',
    historico: [{ status: 'novo', em: new Date().toISOString() }],
    empresa: dados.empresa || '',
    agendadoPara: /^\d{2}:\d{2}$/.test(dados.agendadoPara || '') ? dados.agendadoPara : '',
    impresso: false,
    erroImpressao: null,
  };
  db.pedidos.push(pedido);
  try {
    save();
  } catch (e) {
    // Não gravou: desfaz, senão a atendente lança de novo e o pedido sai em dobro.
    db.pedidos.pop();
    db.seqPedido--;
    throw e;
  }
  if (config.get().impressora.imprimirAoConfirmar) await imprimir(pedido.id, { cupom: true, etiquetas: true });
  return pedido;
}

// Taxa de entrega: vazio = "a confirmar" (informada depois); senão número de 0 a 1000.
function lerTaxa(v) {
  if (v === null || v === undefined || v === '') return null;
  const t = contas.valorDigitado(v);
  if (!(t >= 0) || t > 1000) throw new Error('Taxa de entrega inválida');
  return t;
}

function erroSemConta(nome) {
  return contas.homonimos(nome).length > 1
    ? 'Há mais de um cliente com esse nome: escolha qual é (ou digite o telefone)'
    : 'Para anotar, digite o nome do cliente ou da empresa';
}

// Número curto que recomeça todo dia (#1, #2, ...), mais fácil de gritar na cozinha.
function numeroDoDia(db) {
  const d = hoje();
  return db.pedidos.filter((p) => p.data === d).length + 1;
}

// o: { cupom, etiquetas } — reimprimir pelo quadro escolhe um ou outro, para não duplicar etiquetas.
async function imprimir(id, o = { cupom: true, etiquetas: true }) {
  const db = load();
  const p = db.pedidos.find((x) => x.id === Number(id));
  if (!p) throw new Error('Pedido não encontrado');
  try {
    await impressora.imprimir(p, o);
    p.impresso = true;
    p.erroImpressao = null;
  } catch (e) {
    p.erroImpressao = e.message;
  }
  marcarSujo(p);
  save();
  return p;
}

function listar(data = hoje()) {
  return load().pedidos.filter((p) => p.data === data).sort((a, b) => b.id - a.id);
}

function obter(id) {
  return load().pedidos.find((x) => x.id === Number(id));
}

function mudarStatus(id, status, extra = {}) {
  if (!STATUS.includes(status)) throw new Error('Status inválido');
  const p = obter(id);
  if (!p) throw new Error('Pedido não encontrado');
  p.status = status;
  (p.historico ??= []).push({ status, em: new Date().toISOString() });
  if (status === 'saiu' && extra.entregador) p.entregador = String(extra.entregador).trim().slice(0, 40);
  marcarSujo(p);
  save();
  return p;
}

// Corrigir a forma de pagamento (ex.: disse Pix e pagou em dinheiro, ou vai anotar para pagar depois).
function alterarPagamento(id, { forma, contaId } = {}) {
  const p = obter(id);
  if (!p) throw new Error('Pedido não encontrado');
  if (!FORMAS_PAGAMENTO.includes(forma)) throw new Error('Forma de pagamento inválida');
  const contaAntes = p.contaId;
  if (forma === contas.ANOTADO) {
    const conta = contas.resolver({ contaId: contaId || p.contaId, empresa: p.empresa, nome: p.cliente.nome, telefone: p.cliente.telefone, anotar: true });
    if (!conta) throw new Error(erroSemConta(p.cliente.nome));
    p.contaId = conta.id;
  }
  const antes = p.pagamento?.forma || '';
  if (antes === forma) {
    if (p.contaId !== contaAntes) { marcarSujo(p); save(); }
    return p;
  }
  p.pagamento = { ...(p.pagamento || {}), forma };
  if (forma !== 'Dinheiro') delete p.pagamento.troco;
  (p.pagamento.alteracoes ??= []).push({ de: antes, para: forma, em: new Date().toISOString() });
  marcarSujo(p);
  save();
  return p;
}

// Taxa de entrega "a confirmar" informada depois: entra no total (e na conta, se for anotado).
function definirTaxa(id, valor) {
  const p = obter(id);
  if (!p) throw new Error('Pedido não encontrado');
  if (p.entrega?.tipo !== 'entrega') throw new Error('Este pedido não é de entrega');
  const taxa = lerTaxa(valor);
  p.entrega.taxa = taxa;
  p.total = contas.r2(p.itens.reduce((s, i) => s + i.total, 0) + (taxa || 0));
  marcarSujo(p);
  save();
  return p;
}

function resumoTexto(p) {
  const linhas = p.itens.map((it) => {
    const extras = [...Object.entries(it.opcoes || {}).map(([k, v]) => `${k.toLowerCase()} ${v.toLowerCase()}`), ...it.adicionais.map((a) => '+ ' + a.nome.toLowerCase())];
    let l = `• ${it.quantidade}x ${it.nome} ${it.tamanho}${it.funcionario ? ` — ${it.funcionario}` : ''}`;
    if (extras.length) l += ` (${extras.join(', ')})`;
    if (it.obs) l += ` — _${it.obs}_`;
    return l + ` ${reais(it.total)}`;
  });
  return linhas.join('\n');
}

module.exports = { STATUS, FORMAS_PAGAMENTO, MAX_QTD_ITEM, criar, imprimir, listar, obter, mudarStatus, alterarPagamento, definirTaxa, calcularItem, resumoTexto };
