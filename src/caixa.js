// Fechamento de caixa do dia e resumo do mês.
//   Vendido  = todos os pedidos do dia (menos os cancelados)
//            = recebido na hora (pedidos finalizados, por forma) + anotado (pagar depois) + pendente (não finalizado)
//   Entrou   = recebido na hora + pagamentos de contas anotadas recebidos no dia
//   Gaveta   = troco inicial + dinheiro que entrou - retiradas  -> confere com o dinheiro contado
const { load, save } = require('./db');
const { hoje, reais, dataPorExtenso } = require('./util');
const contas = require('./contas');
const impressora = require('./impressora');
const config = require('./config');

const FORMAS = ['Dinheiro', 'Pix', 'Cartão'];
const { r2, ANOTADO, valorDigitado } = contas;

function validarData(data) {
  const d = String(data);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || new Date(d + 'T12:00:00Z').toISOString().slice(0, 10) !== d) throw new Error('Data inválida');
  return d;
}

const vazio = () => ({ abertura: null, sangrias: [], fechamento: null });
function registro(data) {
  return (load().caixas[validarData(data)] ??= vazio());
}

function situacao(p) {
  if (p.status === 'cancelado') return 'cancelado';
  if (p.pagamento?.forma === ANOTADO) return 'anotado';
  if (p.status === 'entregue') return 'recebido';
  return 'pendente';
}
const formaDe = (f) => (FORMAS.includes(f) ? f : 'Outro');
const porForma = () => ({ Dinheiro: 0, Pix: 0, 'Cartão': 0, Outro: 0, total: 0 });
const arredondar = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r2(v)]));
const nomeDoPedido = (p) => p.empresa || p.cliente?.nome || 'Cliente';

function calcular(data, peds, recs, caixa) {
  const db = load();
  const vendas = porForma(), dasContas = porForma();
  const t = { pedidos: 0, marmitas: 0, vendido: 0, anotado: 0, pendente: 0, taxas: 0 };
  const cancelados = { qtd: 0, valor: 0 };
  const anotadoPorConta = new Map();
  const pendentes = [];
  const taxaAConfirmar = [];
  for (const p of peds) {
    const sit = situacao(p);
    if (sit === 'cancelado') { cancelados.qtd++; cancelados.valor += p.total; continue; }
    t.pedidos++;
    t.vendido += p.total;
    t.marmitas += p.itens.reduce((s, it) => s + it.quantidade, 0);
    t.taxas += p.entrega?.taxa || 0;
    if (p.entrega?.tipo === 'entrega' && p.entrega.taxa == null) taxaAConfirmar.push({ id: p.id, numero: p.numero, nome: nomeDoPedido(p) });
    if (sit === 'anotado') {
      t.anotado += p.total;
      const k = p.contaId || 'sem-conta-' + p.id;
      const a = anotadoPorConta.get(k) || anotadoPorConta.set(k, { contaId: p.contaId, nome: db.contas[p.contaId]?.nome || nomeDoPedido(p), valor: 0, pedidos: 0 }).get(k);
      a.valor += p.total;
      a.pedidos++;
    } else if (sit === 'recebido') {
      vendas[formaDe(p.pagamento?.forma)] += p.total;
      vendas.total += p.total;
    } else {
      t.pendente += p.total;
      pendentes.push({ id: p.id, numero: p.numero, nome: nomeDoPedido(p), total: p.total, status: p.status, forma: p.pagamento?.forma || '' });
    }
  }
  for (const r of recs) {
    if (r.cancelado) continue;
    dasContas[formaDe(r.forma)] += r.valor;
    dasContas.total += r.valor;
  }
  const entrou = Object.fromEntries(Object.keys(vendas).map((k) => [k, vendas[k] + dasContas[k]]));
  const retiradas = (caixa.sangrias || []).reduce((s, x) => s + x.valor, 0);
  const abertura = caixa.abertura || 0;
  return {
    data,
    ...arredondar(t),
    cancelados: arredondar(cancelados),
    recebidoVendas: arredondar(vendas),
    recebidoContas: arredondar(dasContas),
    entrou: arredondar(entrou),
    gaveta: arredondar({ abertura, dinheiro: entrou.Dinheiro, retiradas, esperado: abertura + entrou.Dinheiro - retiradas }),
    anotadoPorConta: [...anotadoPorConta.values()].map((a) => ({ ...a, valor: r2(a.valor) })).sort((a, b) => b.valor - a.valor),
    pendentes,
    taxaAConfirmar,
  };
}

// Números que, se mudarem depois do fechamento, merecem aviso.
const CONFERIR = (r) => ({
  vendido: r.vendido, anotado: r.anotado, pendente: r.pendente, entrou: r.entrou.total, esperado: r.gaveta.esperado,
  dinheiro: r.entrou.Dinheiro, pix: r.entrou.Pix, cartao: r.entrou['Cartão'], outro: r.entrou.Outro,
});
const mudou = (f, r) => !!f?.conferir && JSON.stringify(f.conferir) !== JSON.stringify(CONFERIR(r));

function resumo(data = hoje()) {
  validarData(data);
  const db = load();
  const caixa = db.caixas[data] || vazio();
  const peds = db.pedidos.filter((p) => p.data === data).sort((a, b) => a.id - b.id);
  const recs = db.recebimentos.filter((r) => r.data === data).sort((a, b) => a.id - b.id);
  const r = calcular(data, peds, recs, caixa);
  const f = caixa.fechamento;
  const mudouDepois = mudou(f, r);
  return {
    ...r,
    abertura: caixa.abertura,
    sangrias: caixa.sangrias || [],
    fechamento: f,
    mudouDepois,
    lista: peds.map((p) => ({
      id: p.id, numero: p.numero, criadoEm: p.criadoEm, origem: p.origem, nome: nomeDoPedido(p), contaId: p.contaId,
      marmitas: p.itens.reduce((s, it) => s + it.quantidade, 0), total: p.total, forma: p.pagamento?.forma || '', status: p.status, situacao: situacao(p),
      taxaAConfirmar: p.status !== 'cancelado' && p.entrega?.tipo === 'entrega' && p.entrega.taxa == null,
    })),
    recebimentos: recs.map((x) => ({ ...x, nome: db.contas[x.contaId]?.nome || '(cliente excluído)' })),
  };
}

function definirAbertura(data, valor) {
  const cx = registro(data);
  if (valor === '' || valor === null || valor === undefined) cx.abertura = null;
  else {
    const v = valorDigitado(valor);
    if (!(v >= 0) || v > 100000) throw new Error('Valor inválido');
    cx.abertura = v;
  }
  save();
  return resumo(data);
}

// Retirada de dinheiro da gaveta (ex.: pagou o entregador, comprou gás).
function adicionarSangria(data, { valor, descricao } = {}) {
  const cx = registro(data);
  const v = valorDigitado(valor);
  if (!(v > 0) || v > 100000) throw new Error('Valor inválido');
  const id = cx.sangrias.reduce((m, s) => Math.max(m, s.id), 0) + 1;
  cx.sangrias.push({ id, valor: v, descricao: String(descricao || '').trim().slice(0, 80) || 'Retirada', em: new Date().toISOString() });
  save();
  return resumo(data);
}

function removerSangria(data, id) {
  const cx = registro(data);
  const i = cx.sangrias.findIndex((s) => s.id === Number(id));
  if (i < 0) throw new Error('Retirada não encontrada');
  cx.sangrias.splice(i, 1);
  save();
  return resumo(data);
}

function fechar(data, { contado, obs } = {}) {
  validarData(data);
  if (contado === '' || contado === null || contado === undefined) throw new Error('Digite quanto dinheiro tem na gaveta');
  const c = valorDigitado(contado);
  if (!(c >= 0) || c > 1000000) throw new Error('Valor contado inválido');
  const r = resumo(data);
  const cx = registro(data);
  cx.fechamento = {
    em: new Date().toISOString(),
    contado: c,
    diferenca: r2(c - r.gaveta.esperado),
    obs: String(obs || '').trim().slice(0, 300),
    conferir: CONFERIR(r),
    resumo: { pedidos: r.pedidos, marmitas: r.marmitas, vendido: r.vendido, anotado: r.anotado, pendente: r.pendente, recebidoVendas: r.recebidoVendas, recebidoContas: r.recebidoContas, entrou: r.entrou, gaveta: r.gaveta, cancelados: r.cancelados },
  };
  save();
  return resumo(data);
}

function reabrir(data) {
  const cx = registro(data);
  cx.fechamento = null;
  save();
  return resumo(data);
}

// Uma linha por dia do mês com movimento, mais o total.
function resumoMes(mes = hoje().slice(0, 7)) {
  if (!/^\d{4}-\d{2}$/.test(mes)) throw new Error('Mês inválido');
  const db = load();
  const dias = new Map();
  const dia = (d) => dias.get(d) || dias.set(d, { peds: [], recs: [] }).get(d);
  for (const p of db.pedidos) if (p.data.startsWith(mes)) dia(p.data).peds.push(p);
  for (const r of db.recebimentos) if (r.data.startsWith(mes)) dia(r.data).recs.push(r);
  for (const d of Object.keys(db.caixas)) if (d.startsWith(mes)) dia(d);
  const linhas = [...dias.keys()].sort().map((d) => {
    const cx = db.caixas[d] || vazio();
    const r = calcular(d, dias.get(d).peds, dias.get(d).recs, cx);
    return {
      data: d, pedidos: r.pedidos, marmitas: r.marmitas, vendido: r.vendido, recebido: r.recebidoVendas.total, anotado: r.anotado,
      pendente: r.pendente, recebidoContas: r.recebidoContas.total, entrou: r.entrou, fechado: !!cx.fechamento,
      diferenca: cx.fechamento ? r2(cx.fechamento.contado - r.gaveta.esperado) : null, mudouDepois: mudou(cx.fechamento, r),
    };
  });
  const soma = (k) => r2(linhas.reduce((s, l) => s + l[k], 0));
  const entrou = porForma();
  for (const l of linhas) for (const k of Object.keys(entrou)) entrou[k] += l.entrou[k];
  return {
    mes,
    dias: linhas,
    total: { pedidos: soma('pedidos'), marmitas: soma('marmitas'), vendido: soma('vendido'), recebido: soma('recebido'), anotado: soma('anotado'), pendente: soma('pendente'), recebidoContas: soma('recebidoContas'), entrou: arredondar(entrou) },
  };
}

// Papel do fechamento para a impressora térmica.
function montarCupom(r) {
  const cols = config.get().impressora.colunas || 48;
  const L = [];
  const add = (texto, estilo = {}) => L.push({ texto: String(texto), ...estilo });
  // Texto já no formato da impressora (sem emoji, "…" vira "...") antes de medir as colunas.
  const duas = (esq, dir, estilo = {}) => {
    const d = impressora.paraImpressora(dir, false);
    const e = impressora.paraImpressora(esq, false).slice(0, Math.max(1, cols - d.length - 1));
    add(e + ' '.repeat(Math.max(1, cols - e.length - d.length)) + d, { fixo: true, ...estilo });
  };
  const hora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  add('FECHAMENTO DE CAIXA', { grande: true, centro: true });
  add(dataPorExtenso(r.data) + '/' + r.data.slice(0, 4), { centro: true });
  if (r.fechamento) add(`Fechado as ${hora(r.fechamento.em)}`, { centro: true });
  if (r.mudouDepois) add('ATENCAO: mudou depois do fechamento', { negrito: true, centro: true });
  add('-', { linha: true });
  duas('VENDIDO', reais(r.vendido), { negrito: true });
  add(`${r.pedidos} pedidos, ${r.marmitas} marmitas`);
  duas('  Recebido na hora', reais(r.recebidoVendas.total));
  for (const f of [...FORMAS, 'Outro']) if (r.recebidoVendas[f]) duas('    ' + f, reais(r.recebidoVendas[f]));
  duas('  Anotado (pagar depois)', reais(r.anotado));
  if (r.pendente) duas('  Nao finalizado', reais(r.pendente));
  add('-', { linha: true });
  duas('RECEBIDO DE CONTAS', reais(r.recebidoContas.total), { negrito: true });
  for (const f of [...FORMAS, 'Outro']) if (r.recebidoContas[f]) duas('    ' + f, reais(r.recebidoContas[f]));
  add('-', { linha: true });
  duas('TOTAL QUE ENTROU', reais(r.entrou.total), { negrito: true });
  for (const f of [...FORMAS, 'Outro']) if (r.entrou[f] || f !== 'Outro') duas('    ' + f, reais(r.entrou[f]));
  add('-', { linha: true });
  add('DINHEIRO NA GAVETA', { negrito: true });
  duas('  Troco inicial', reais(r.gaveta.abertura));
  duas('  + Dinheiro recebido', reais(r.gaveta.dinheiro));
  duas('  - Retiradas', reais(r.gaveta.retiradas));
  for (const s of r.sangrias) duas('      ' + s.descricao, reais(s.valor));
  duas('  = Deveria ter', reais(r.gaveta.esperado), { negrito: true });
  if (r.fechamento) {
    duas('  Contado', reais(r.fechamento.contado), { negrito: true });
    const d = r2(r.fechamento.contado - r.gaveta.esperado); // com o "deveria ter" de agora
    duas(d === 0 ? '  Conferido: sem diferenca' : d > 0 ? '  SOBROU' : '  FALTOU', d === 0 ? '' : reais(Math.abs(d)), { negrito: true });
  }
  if (r.anotadoPorConta.length) {
    add('-', { linha: true });
    add('ANOTADO HOJE', { negrito: true });
    for (const a of r.anotadoPorConta) duas('  ' + a.nome, reais(a.valor));
  }
  if (r.cancelados.qtd) {
    add('-', { linha: true });
    duas(`Cancelados (${r.cancelados.qtd})`, reais(r.cancelados.valor));
  }
  if (r.pendentes.length) {
    add('-', { linha: true });
    add('PEDIDOS NAO FINALIZADOS', { negrito: true });
    for (const p of r.pendentes) duas(`  #${p.numero} ${p.nome}`, reais(p.total));
  }
  if (r.fechamento?.obs) add('Obs: ' + r.fechamento.obs);
  add('-', { linha: true });
  add(config.get().nomeLoja, { centro: true });
  return L;
}

async function imprimir(data = hoje()) {
  const r = resumo(data);
  await impressora.imprimirFolhas([montarCupom(r)], `caixa-${data}`);
  return { ok: true };
}

module.exports = { FORMAS, resumo, resumoMes, definirAbertura, adicionarSangria, removerSangria, fechar, reabrir, imprimir, montarCupom };
