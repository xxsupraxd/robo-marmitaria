// Conta de cada cliente e de cada empresa: guarda o histórico de pedidos e o que foi anotado
// para pagar depois (o "caderno de fiado"). O saldo em aberto é: tudo que foi anotado menos tudo
// que já foi recebido.
const { load, save, marcarSujo } = require('./db');
const { hoje, reais, semAcentos, normalizarTelefone, formatarTelefone } = require('./util');
const config = require('./config');

const ANOTADO = 'Anotado';
const FORMAS_RECEBIMENTO = ['Dinheiro', 'Pix', 'Cartão'];

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const normNome = (s) => semAcentos(String(s || '')).toLowerCase().replace(/\s+/g, ' ').trim();
// Só telefone completo (com DDD) serve para reconhecer o cliente. Celular antigo sem o 9 na frente
// (o WhatsApp às vezes manda assim) ganha o 9, para o mesmo cliente não virar duas contas.
const telValido = (t) => {
  const n = normalizarTelefone(t);
  if (!/^55\d{10,11}$/.test(n)) return '';
  return n.length === 12 && /[6-9]/.test(n[4]) ? n.slice(0, 4) + '9' + n.slice(4) : n;
};
// Telefone principal e os que vieram de cadastros juntados.
const telefonesDe = (c) => [c.telefone, ...(c.telefones || [])].filter(Boolean);
const ehAnotado = (p) => p.status !== 'cancelado' && p.pagamento?.forma === ANOTADO;

function obter(id) {
  return load().contas[Number(id)] || null;
}

function criarConta({ tipo, nome, telefone }) {
  const db = load();
  const id = ++db.seqConta;
  const c = {
    id,
    tipo: tipo === 'empresa' ? 'empresa' : 'pessoa',
    nome: String(nome || '').trim().slice(0, 80) || 'Sem nome',
    telefone: telValido(telefone),
    anotar: false, // pode escolher "anotar na minha conta" sozinho pelo WhatsApp
    obs: '',
    criadoEm: new Date().toISOString(),
  };
  db.contas[id] = c;
  return c;
}

// Pelo telefone só se acha conta de pessoa. Empresa é achada pelo nome: o telefone que aparece num
// pedido de empresa é de quem ligou, e os pedidos pessoais dessa pessoa não podem cair na conta da empresa.
function porTelefone(telefone) {
  const tel = telValido(telefone);
  if (!tel) return null;
  return Object.values(load().contas).find((c) => c.tipo === 'pessoa' && telefonesDe(c).includes(tel)) || null;
}

// Quantas pessoas cadastradas têm esse nome (para não anotar no João errado).
function homonimos(nome) {
  const n = normNome(nome);
  return n ? Object.values(load().contas).filter((c) => c.tipo === 'pessoa' && normNome(c.nome) === n) : [];
}

// Acha (ou abre) a conta de um pedido. Ordem: conta escolhida no balcão > empresa > telefone >
// nome (só quando é para anotar, porque nome sozinho pode ser de outra pessoa; se houver duas pessoas
// com o mesmo nome, não escolhe nenhuma). Não grava: quem chama grava junto com o pedido.
function resolver({ contaId, empresa, nome, telefone, anotar } = {}) {
  const db = load();
  if (contaId && db.contas[Number(contaId)]) return db.contas[Number(contaId)];
  const contas = Object.values(db.contas);
  const tel = telValido(telefone);
  const emp = normNome(empresa);
  if (emp) return contas.find((x) => x.tipo === 'empresa' && normNome(x.nome) === emp) || criarConta({ tipo: 'empresa', nome: empresa });
  if (tel) {
    const c = porTelefone(tel);
    if (c) {
      if ((!c.nome || c.nome === 'Sem nome' || c.nome === formatarTelefone(tel)) && String(nome || '').trim()) c.nome = String(nome).trim().slice(0, 80);
      return c;
    }
    return criarConta({ tipo: 'pessoa', nome: String(nome || '').trim() || formatarTelefone(tel), telefone: tel });
  }
  if (!anotar || !normNome(nome)) return null;
  const iguais = homonimos(nome);
  if (iguais.length > 1) return null;
  return iguais[0] || criarConta({ tipo: 'pessoa', nome });
}

// contaId -> { anotado, recebido, saldo } de todo o histórico.
function saldos() {
  const db = load();
  const m = new Map();
  const de = (id) => m.get(id) || m.set(id, { anotado: 0, recebido: 0, saldo: 0 }).get(id);
  for (const p of db.pedidos) if (p.contaId && ehAnotado(p)) de(p.contaId).anotado += p.total;
  for (const r of db.recebimentos) if (!r.cancelado) de(r.contaId).recebido += r.valor;
  for (const v of m.values()) {
    v.anotado = r2(v.anotado);
    v.recebido = r2(v.recebido);
    v.saldo = r2(v.anotado - v.recebido);
  }
  return m;
}

function listar({ busca = '', mes = hoje().slice(0, 7), abertas = false } = {}) {
  const db = load();
  const s = saldos();
  const est = new Map();
  for (const p of db.pedidos) {
    if (!p.contaId || p.status === 'cancelado') continue;
    const e = est.get(p.contaId) || est.set(p.contaId, { pedidos: 0, pedidosMes: 0, totalMes: 0, ultimoPedido: null }).get(p.contaId);
    e.pedidos++;
    if (p.data.startsWith(mes)) { e.pedidosMes++; e.totalMes += p.total; }
    if (!e.ultimoPedido || p.criadoEm > e.ultimoPedido) e.ultimoPedido = p.criadoEm;
  }
  const b = normNome(busca);
  const digitos = String(busca).replace(/\D/g, '');
  return Object.values(db.contas)
    .map((c) => {
      const e = est.get(c.id) || { pedidos: 0, pedidosMes: 0, totalMes: 0, ultimoPedido: null };
      return { ...c, ...(s.get(c.id) || { anotado: 0, recebido: 0, saldo: 0 }), ...e, totalMes: r2(e.totalMes) };
    })
    .filter((c) => !b || normNome(c.nome).includes(b) || (digitos.length >= 3 && c.telefone.includes(digitos)))
    .filter((c) => !abertas || c.saldo > 0)
    .sort((a, b2) => b2.saldo - a.saldo || String(b2.ultimoPedido || '').localeCompare(String(a.ultimoPedido || '')) || a.nome.localeCompare(b2.nome));
}

// Cadastrar ou editar pelo painel.
function salvar(dados = {}) {
  const db = load();
  let c = dados.id ? obter(dados.id) : null;
  if (dados.id && !c) throw new Error('Cliente não encontrado');
  const nome = String(dados.nome ?? c?.nome ?? '').trim().slice(0, 80);
  if (!nome) throw new Error('Digite o nome');
  const tipo = (dados.tipo ?? c?.tipo) === 'empresa' ? 'empresa' : 'pessoa';
  const tel = dados.telefone !== undefined ? telValido(dados.telefone) : c?.telefone || '';
  if (dados.telefone && !tel) throw new Error('Telefone incompleto: use DDD + número');
  const outras = Object.values(db.contas).filter((x) => x.id !== c?.id);
  if (tipo === 'empresa' && outras.some((x) => x.tipo === 'empresa' && normNome(x.nome) === normNome(nome))) throw new Error('Já existe uma empresa com esse nome');
  if (tel && tipo === 'pessoa' && outras.some((x) => x.tipo === 'pessoa' && telefonesDe(x).includes(tel))) throw new Error('Já existe um cliente com esse telefone');
  if (!c) c = criarConta({ tipo, nome, telefone: tel });
  Object.assign(c, {
    tipo,
    nome,
    telefone: tel,
    anotar: tipo === 'pessoa' && (dados.anotar !== undefined ? !!dados.anotar : !!c.anotar),
    obs: String(dados.obs ?? c.obs ?? '').trim().slice(0, 300),
  });
  save();
  return c;
}

// Cadastro repetido (ex.: "João" sem telefone e "João" com telefone): passa tudo para uma conta só.
function juntar(origemId, destinoId) {
  const db = load();
  const o = obter(origemId), d = obter(destinoId);
  if (!o || !d) throw new Error('Cliente não encontrado');
  if (o.id === d.id) throw new Error('Escolha outro cliente');
  for (const p of db.pedidos) if (p.contaId === o.id) { p.contaId = d.id; marcarSujo(p); }
  for (const r of db.recebimentos) if (r.contaId === o.id) r.contaId = d.id;
  // Os telefones da conta apagada continuam reconhecendo o cliente.
  const tels = [...new Set([...telefonesDe(d), ...telefonesDe(o)])];
  d.telefone = tels[0] || '';
  d.telefones = tels.slice(1);
  d.anotar = d.tipo === 'pessoa' && (d.anotar || o.anotar);
  if (o.obs) d.obs = [d.obs, o.obs].filter(Boolean).join(' / ').slice(0, 300);
  delete db.contas[o.id];
  save();
  return d;
}

function excluir(id) {
  const db = load();
  const c = obter(id);
  if (!c) throw new Error('Cliente não encontrado');
  if (db.pedidos.some((p) => p.contaId === c.id && p.status !== 'cancelado') || db.recebimentos.some((r) => r.contaId === c.id && !r.cancelado)) {
    throw new Error('Este cliente tem pedidos ou pagamentos. Use "Juntar com outro cliente" se for repetido.');
  }
  // Só sobrou coisa cancelada (ex.: pedido de teste): solta do cadastro e apaga.
  for (const p of db.pedidos) if (p.contaId === c.id) { p.contaId = null; marcarSujo(p); }
  delete db.contas[c.id];
  save();
  return { ok: true };
}

// Pagamento de conta anotada (ex.: a empresa pagou o mês). Entra no caixa do dia.
function receber(contaId, { valor, forma, obs } = {}) {
  const db = load();
  const c = obter(contaId);
  if (!c) throw new Error('Cliente não encontrado');
  const v = valorDigitado(valor);
  if (!(v > 0) || v > 1000000) throw new Error('Valor inválido');
  if (!FORMAS_RECEBIMENTO.includes(forma)) throw new Error('Escolha a forma de pagamento');
  const r = {
    id: ++db.seqRecebimento,
    contaId: c.id,
    valor: v,
    forma,
    data: hoje(),
    em: new Date().toISOString(),
    obs: String(obs || '').trim().slice(0, 200),
    cancelado: false,
  };
  db.recebimentos.push(r);
  try {
    save();
  } catch (e) {
    // Não gravou: desfaz, senão a atendente lança de novo e o pagamento fica em dobro.
    db.recebimentos.pop();
    db.seqRecebimento--;
    throw e;
  }
  return r;
}

// "20", "20,50", 20.5 -> número; texto que não é número -> NaN (nunca vira 0 sem querer).
function valorDigitado(v) {
  const t = String(v ?? '').trim().replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return NaN;
  return r2(Number(t));
}

function cancelarRecebimento(id) {
  const r = load().recebimentos.find((x) => x.id === Number(id));
  if (!r) throw new Error('Pagamento não encontrado');
  r.cancelado = true;
  r.canceladoEm = new Date().toISOString();
  save();
  return r;
}

function extrasItem(it) {
  return [...Object.values(it.opcoes || {}), ...(it.adicionais || []).map((a) => '+' + a.nome)];
}

// Tudo de um mês de uma conta: pedidos, pagamentos, saldo e total por funcionário (empresa).
function extrato(contaId, mes = hoje().slice(0, 7)) {
  if (!/^\d{4}-\d{2}$/.test(mes)) throw new Error('Mês inválido');
  const db = load();
  const c = obter(contaId);
  if (!c) throw Object.assign(new Error('Cliente não encontrado'), { status: 404 });
  const inicio = mes + '-01';
  const daConta = db.pedidos.filter((p) => p.contaId === c.id && p.status !== 'cancelado');
  const recs = db.recebimentos.filter((r) => r.contaId === c.id && !r.cancelado);
  const pedidosMes = daConta.filter((p) => p.data.startsWith(mes)).sort((a, b) => a.id - b.id);
  const recMes = recs.filter((r) => r.data.startsWith(mes)).sort((a, b) => a.id - b.id);
  const soma = (l, f) => r2(l.reduce((s, x) => s + f(x), 0));
  const saldoAnterior = r2(soma(daConta.filter((p) => p.data < inicio && ehAnotado(p)), (p) => p.total) - soma(recs.filter((r) => r.data < inicio), (r) => r.valor));
  const anotado = soma(pedidosMes.filter(ehAnotado), (p) => p.total);
  const recebido = soma(recMes, (r) => r.valor);

  let porFuncionario = null;
  if (pedidosMes.some((p) => p.itens.some((it) => it.funcionario))) {
    const m = new Map();
    for (const p of pedidosMes) {
      for (const it of p.itens) {
        const k = normNome(it.funcionario) || '';
        const f = m.get(k) || m.set(k, { nome: String(it.funcionario || '').trim() || '(sem nome)', marmitas: 0, valor: 0 }).get(k);
        f.marmitas += it.quantidade;
        f.valor += it.total;
      }
    }
    porFuncionario = [...m.values()].map((f) => ({ ...f, valor: r2(f.valor) })).sort((a, b) => a.nome.localeCompare(b.nome));
  }

  const ex = {
    conta: c,
    mes,
    pedidos: pedidosMes.map((p) => ({
      id: p.id,
      numero: p.numero,
      data: p.data,
      criadoEm: p.criadoEm,
      cliente: p.cliente.nome,
      empresa: p.empresa,
      itens: p.itens.map((it) => ({ quantidade: it.quantidade, nome: it.nome, tamanho: it.tamanho, extras: extrasItem(it), funcionario: it.funcionario || '', obs: it.obs || '', total: it.total })),
      taxa: p.entrega?.taxa || 0,
      total: p.total,
      forma: p.pagamento?.forma || '',
      status: p.status,
    })),
    recebimentos: recMes,
    totais: {
      pedidos: pedidosMes.length,
      marmitas: pedidosMes.reduce((s, p) => s + p.itens.reduce((a, it) => a + it.quantidade, 0), 0),
      total: soma(pedidosMes, (p) => p.total),
      taxas: soma(pedidosMes, (p) => p.entrega?.taxa || 0),
      anotado,
      pagoNaHora: soma(pedidosMes.filter((p) => !ehAnotado(p) && p.status === 'entregue'), (p) => p.total),
      naoFinalizado: soma(pedidosMes.filter((p) => !ehAnotado(p) && p.status !== 'entregue'), (p) => p.total),
      recebido,
    },
    saldoAnterior,
    saldoFinal: r2(saldoAnterior + anotado - recebido),
    saldoHoje: saldos().get(c.id)?.saldo || 0,
    porFuncionario,
  };
  ex.texto = textoExtrato(ex);
  return ex;
}

const nomeMes = (mes) => {
  const [a, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, 15)).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

// Resumo para colar no WhatsApp do cliente.
function textoExtrato(ex) {
  const cfg = config.get();
  const t = ex.totais;
  const L = [`*${cfg.nomeLoja}*`, `Extrato de ${nomeMes(ex.mes)} · ${ex.conta.nome}`, ''];
  for (const p of ex.pedidos) {
    const marmitas = p.itens.reduce((s, it) => s + it.quantidade, 0);
    const situacao = p.forma === ANOTADO ? '' : p.status === 'entregue' ? ` (pago: ${p.forma})` : ' (não finalizado)';
    L.push(`${p.data.slice(8, 10)}/${p.data.slice(5, 7)} · ${marmitas} marmita${marmitas > 1 ? 's' : ''} · ${reais(p.total)}${situacao}`);
  }
  if (!ex.pedidos.length) L.push('Nenhum pedido neste mês.');
  L.push('', `Total do mês: ${reais(t.total)} (${t.marmitas} marmitas)`);
  if (t.pagoNaHora) L.push(`Já pago na hora: ${reais(t.pagoNaHora)}`);
  if (ex.saldoAnterior) L.push(`Saldo de meses anteriores: ${reais(ex.saldoAnterior)}`);
  if (t.recebido) L.push(`Pagamentos recebidos: ${reais(t.recebido)}`);
  L.push(ex.saldoFinal > 0 ? `*Total a pagar: ${reais(ex.saldoFinal)}*` : ex.saldoFinal < 0 ? `*Crédito: ${reais(-ex.saldoFinal)}*` : '*Nada a pagar. Obrigado!*');
  if (ex.saldoFinal > 0 && cfg.chavePix) L.push(`Chave Pix: ${cfg.chavePix}`);
  return L.join('\n');
}

// Pedidos feitos antes de existir a conta de clientes: liga pela empresa ou pelo telefone.
function vincularAntigos() {
  const db = load();
  let n = 0;
  for (const p of db.pedidos) {
    if (p.contaId !== undefined) continue;
    const c = resolver({ empresa: p.empresa, nome: p.cliente?.nome, telefone: p.cliente?.telefone, anotar: p.pagamento?.forma === ANOTADO });
    p.contaId = c ? c.id : null;
    marcarSujo(p);
    n++;
  }
  if (n) save();
  return n;
}

module.exports = {
  ANOTADO, FORMAS_RECEBIMENTO, r2, normNome, ehAnotado, telValido, valorDigitado,
  obter, porTelefone, homonimos, resolver, saldos, listar, salvar, juntar, excluir, receber, cancelarRecebimento, extrato, vincularAntigos,
};
