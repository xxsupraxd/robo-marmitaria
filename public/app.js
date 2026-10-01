// Painel do balcão (JavaScript puro, sem dependências).
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const reais = (v) => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const hora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fmtTel = (n) => { const m = String(n).match(/^55(\d{2})(\d{4,5})(\d{4})$/); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : n; };
const dataBR = (d) => String(d || '').split('-').reverse().join('/');
const normNome = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
// Mesmo jeito do servidor (src/contas.js): DDD obrigatório e celular antigo sem o 9 ganha o 9.
const telCompleto = (t) => {
  let n = String(t || '').replace(/\D/g, '');
  if (n.length === 10 || n.length === 11) n = '55' + n;
  if (!/^55\d{10,11}$/.test(n)) return '';
  return n.length === 12 && /[6-9]/.test(n[4]) ? n.slice(0, 4) + '9' + n.slice(4) : n;
};
const telefonesDe = (c) => [c.telefone, ...(c.telefones || [])].filter(Boolean);
const nomeForma = (f) => (f === 'Anotado' ? '📒 Anotado (pagar depois)' : f || '');
const whats = (s) => esc(s).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/_([^_\n]+)_/g, '<i>$1</i>');

async function api(metodo, url, body) {
  const r = await fetch(url, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json();
  if (!r.ok) throw new Error(d.erro || 'Erro');
  return d;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2500);
}
function bip() {
  try {
    const ctx = new AudioContext(); const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination); o.frequency.value = 880; g.gain.value = 0.2;
    o.start(); o.stop(ctx.currentTime + 0.25);
  } catch {}
}

// ---------- Abas
let abaAtual = 'pedidos';
document.querySelectorAll('#abas button').forEach((b) => (b.onclick = () => abrirAba(b.dataset.aba)));
function abrirAba(nome) {
  abaAtual = nome;
  document.querySelectorAll('#abas button').forEach((b) => b.classList.toggle('ativa', b.dataset.aba === nome));
  document.querySelectorAll('.aba').forEach((s) => s.classList.toggle('ativa', s.id === 'aba-' + nome));
  ({ balcao: carregarBalcao, caixa: carregarCaixa, clientes: carregarClientes, cardapio: carregarCardapio, contatos: carregarContatos, config: carregarConfig, simulador: carregarSimulador }[nome] || (() => {}))();
}

// ---------- Pedidos (quadro por etapa)
const ATRASO_MIN = 40; // pedido aberto há mais que isso fica destacado
let idsConhecidos = null;
const ehEntrega = (p) => p.entrega?.tipo === 'entrega';
const minutosDesde = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
const quandoEntrou = (p, st) => (p.historico || []).filter((h) => h.status === st).pop()?.em;

async function atualizarPedidos() {
  const lista = await api('GET', '/api/pedidos');
  const ids = new Set(lista.map((p) => p.id));
  if (idsConhecidos && lista.some((p) => !idsConhecidos.has(p.id))) { bip(); toast('Novo pedido!'); }
  idsConhecidos = ids;
  const ativos = lista.filter((p) => p.status !== 'cancelado');
  $('#bNovos').textContent = lista.filter((p) => p.status === 'novo').length || '';
  $('#resumoPedidos').textContent = `${ativos.length} pedidos · ${ativos.reduce((s, p) => s + p.itens.reduce((a, i) => a + i.quantidade, 0), 0)} marmitas · ${reais(ativos.reduce((s, p) => s + p.total, 0))}`;

  // Agendados primeiro pelo horário; o resto pela ordem de chegada (mais antigo em cima).
  const ordem = (a, b) => (a.agendadoPara || '99') .localeCompare(b.agendadoPara || '99') || a.id - b.id;
  const col = {
    Novo: lista.filter((p) => p.status === 'novo').sort(ordem),
    Preparo: lista.filter((p) => p.status === 'preparando').sort(ordem),
    Saida: lista.filter((p) => ['pronto', 'saiu'].includes(p.status)).sort(ordem),
    Fim: lista.filter((p) => ['entregue', 'cancelado'].includes(p.status)).sort((a, b) => b.id - a.id),
  };
  for (const [k, ps] of Object.entries(col)) {
    $('#col' + k).innerHTML = ps.map(k === 'Fim' ? htmlFinalizado : htmlPedido).join('') || '<p class="dica" style="padding:4px">Nenhum</p>';
    $('#q' + k).textContent = ps.length || '';
  }
}

function botaoPrincipal(p) {
  if (p.status === 'novo') return `<button class="principal" onclick="mudarStatus(${p.id}, 'preparando')">▶ Iniciar preparo</button>`;
  if (p.status === 'preparando') return ehEntrega(p)
    ? `<button class="principal saida" onclick="darSaida(${p.id})">🛵 Dar saída</button>`
    : `<button class="principal saida" onclick="mudarStatus(${p.id}, 'pronto')">🔔 Pronto para retirar</button>`;
  if (p.status === 'pronto' || p.status === 'saiu') return `<button class="principal ok" onclick="mudarStatus(${p.id}, 'entregue')">✅ ${p.status === 'saiu' ? 'Entregue' : 'Retirado'}</button>`;
  return '';
}

const listasAbertas = new Set(); // pedidos de empresa com a lista de funcionários aberta (sobrevive à atualização)
function htmlItens(p) {
  const empresa = p.itens.some((it) => it.funcionario);
  const linha = (it) => {
    const extras = [...Object.entries(it.opcoes || {}).map(([k, v]) => `${k} ${v}`), ...it.adicionais.map((a) => '+ ' + a.nome)];
    return `<li>${empresa ? `<span class="func-nome">👤 ${esc(it.funcionario || '(sem nome)')}</span> · ` : ''}<b>${it.quantidade}x ${esc(it.nome)} ${it.tamanho}</b>${extras.length ? ' · ' + esc(extras.join(', ')) : ''}${it.obs ? `<div class="obs">⚠ ${esc(it.obs)}</div>` : ''}</li>`;
  };
  if (!empresa) return `<ul>${p.itens.map(linha).join('')}</ul>`;
  // Empresa: resumo por tipo (para a cozinha, igual ao do cupom) e a lista por funcionário recolhível.
  const resumo = new Map();
  for (const it of p.itens) {
    const extras = [...Object.values(it.opcoes || {}), ...it.adicionais.map((a) => '+' + a.nome)];
    const k = `${it.nome} ${it.tamanho}${extras.length ? ` (${extras.join(', ')})` : ''}`;
    resumo.set(k, (resumo.get(k) || 0) + it.quantidade);
  }
  const marmitas = (lista) => lista.reduce((a, it) => a + it.quantidade, 0);
  const comObs = marmitas(p.itens.filter((it) => it.obs));
  return `<ul>${[...resumo].map(([k, q]) => `<li><b>${q}x ${esc(k)}</b></li>`).join('')}</ul>
    <details ${listasAbertas.has(p.id) ? 'open' : ''} ontoggle="this.open ? listasAbertas.add(${p.id}) : listasAbertas.delete(${p.id})">
      <summary>Por funcionário (${marmitas(p.itens)})${comObs ? ` · <span class="obs">${comObs} com observação</span>` : ''}</summary>
      <ul>${p.itens.map(linha).join('')}</ul></details>`;
}
function htmlPedido(p) {
  const ent = ehEntrega(p) ? `🛵 ${esc(p.entrega.endereco)}` : p.entrega?.tipo === 'retirada' ? '🏠 Retirada' : '🧾 Balcão';
  const min = minutosDesde(p.criadoEm);
  const etapa = p.status === 'saiu' ? `saiu às ${hora(quandoEntrou(p, 'saiu') || p.criadoEm)}${p.entregador ? ' com ' + esc(p.entregador) : ''}`
    : p.status === 'pronto' ? 'aguardando retirada' : `há ${min} min`;
  const atrasado = !p.agendadoPara && ['novo', 'preparando'].includes(p.status) && min >= ATRASO_MIN;
  return `<div class="pedido ${p.status}">
    <div class="cab"><span class="num">#${p.numero}</span><span><span class="tag">${p.origem === 'whatsapp' ? 'WhatsApp' : 'Balcão'}</span> ${hora(p.criadoEm)}</span></div>
    <div class="tempo ${atrasado ? 'atrasado' : ''}">${etapa}</div>
    ${p.agendadoPara ? `<div class="agenda">⏰ Entregar às ${esc(p.agendadoPara)}</div>` : ''}
    ${p.empresa ? `<div class="empresa">🏢 ${esc(p.empresa)}</div>` : ''}
    ${p.cliente.nome || !p.empresa ? `<div class="cli">${esc(p.cliente.nome || 'Cliente')}</div>` : ''}
    ${htmlItens(p)}
    ${p.obs ? `<div class="obs">OBS: ${esc(p.obs)}</div>` : ''}
    ${ehEntrega(p) && p.entrega.taxa == null ? `<div class="taxa-pend">Taxa de entrega a confirmar <button onclick="informarTaxa(${p.id})">Informar taxa</button></div>` : ''}
    <div class="info">${ent}<br>${esc(nomeForma(p.pagamento?.forma))}${p.pagamento?.troco ? ' · troco p/ ' + reais(p.pagamento.troco) : ''} · <b>${reais(p.total)}</b>
      ${p.erroImpressao ? `<br><span class="tag erro" title="${esc(p.erroImpressao)}">erro na impressão</span>` : ''}</div>
    <div class="acoes">
      ${botaoPrincipal(p)}
      <button onclick="reimprimir(${p.id})" title="Imprime de novo o pedido da cozinha">🖨 Imprimir</button>
      ${p.itens.some((it) => it.funcionario) ? `<button onclick="reimprimir(${p.id}, true)" title="Imprime de novo as etiquetas com o nome de cada funcionário">🏷 Etiquetas</button>` : ''}
      <button onclick="verCupom(${p.id})">Ver cupom</button>
      ${p.cliente.telefone && p.origem === 'whatsapp' ? `<button onclick="abrirConversa('${p.cliente.telefone}')">Conversa</button>` : ''}
      <button onclick="if(confirm('Cancelar pedido #${p.numero}?')) mudarStatus(${p.id}, 'cancelado')">Cancelar</button>
    </div></div>`;
}

function htmlFinalizado(p) {
  const fim = quandoEntrou(p, p.status);
  return `<div class="pedido ${p.status}"><div class="cab"><span><b>#${p.numero}</b> ${esc(p.empresa || p.cliente.nome || 'Cliente')}</span><span class="tempo">${p.status === 'cancelado' ? 'cancelado' : fim ? hora(fim) : ''}</span></div>
    <div class="tempo">${p.itens.reduce((a, i) => a + i.quantidade, 0)} marmita(s) · ${reais(p.total)}${p.entregador ? ' · ' + esc(p.entregador) : ''}</div></div>`;
}

async function informarTaxa(id, depois = atualizarPedidos) {
  const v = prompt('Taxa de entrega deste pedido (R$):');
  if (v === null || v.trim() === '') return;
  try { await api('POST', `/api/pedidos/${id}/taxa`, { taxa: v.trim() }); toast('Taxa de entrega lançada'); } catch (e) { toast('Erro: ' + e.message); }
  depois();
}
async function mudarStatus(id, status, extra = {}) { await api('POST', `/api/pedidos/${id}/status`, { status, ...extra }); atualizarPedidos(); }
let ultimoEntregador = '';
function darSaida(id) {
  const nome = prompt('Quem vai entregar? (opcional)', ultimoEntregador);
  if (nome === null) return;
  ultimoEntregador = nome.trim();
  mudarStatus(id, 'saiu', { entregador: ultimoEntregador });
}
async function reimprimir(id, etiquetas = false) {
  if (etiquetas && !confirm('Imprimir de novo TODAS as etiquetas deste pedido?')) return;
  try {
    const p = await api('POST', `/api/pedidos/${id}/imprimir`, { etiquetas });
    toast(p.erroImpressao ? 'Erro: ' + p.erroImpressao : 'Enviado para a impressora');
  } catch (e) { toast('Erro: ' + e.message); }
  atualizarPedidos();
}
async function verCupom(id) {
  const { texto } = await api('GET', `/api/pedidos/${id}/cupom`);
  $('#cupomTexto').textContent = texto; $('#dlgCupom').showModal();
}

// ---------- Conversas
let convAberta = null;
async function atualizarConversas() {
  const lista = await api('GET', '/api/conversas');
  const total = lista.reduce((s, c) => s + c.naoLidas, 0);
  $('#bNaoLidas').textContent = total || '';
  $('#listaConversas').innerHTML = lista.map((c) => `
    <div class="conv ${c.telefone === convAberta ? 'sel' : ''}" onclick="abrirConversa('${c.telefone}')">
      <div class="n"><span>${esc(c.nome || fmtTel(c.telefone))}</span>${c.naoLidas ? `<span class="badge" style="background:var(--verm);color:#fff">${c.naoLidas}</span>` : ''}</div>
      <div class="u">${c.roboPausado ? '🙋 ' : '🤖 '}${esc(c.ultima?.texto || '')}</div>
    </div>`).join('') || '<p class="dica" style="padding:12px">Nenhuma conversa ainda.</p>';
  if (convAberta && abaAtual === 'conversas') renderConversa();
}
async function abrirConversa(tel) {
  convAberta = tel;
  if (abaAtual !== 'conversas') abrirAba('conversas');
  await api('POST', `/api/conversas/${tel}/lida`);
  await renderConversa(true);
  atualizarConversas();
}
function htmlMensagens(msgs) {
  return msgs.map((m) => `<div class="msg ${m.de}">${whats(m.texto)}<span class="h">${m.de === 'atendente' ? (m.celular ? '📱 celular · ' : 'atendente · ') : m.de === 'robo' ? '🤖 · ' : ''}${hora(m.em)}</span></div>`).join('');
}
let ultimoTamanho = 0;
async function renderConversa(rolar) {
  const c = await api('GET', `/api/conversas/${convAberta}`);
  $('#chatTopo').innerHTML = `<div><b>${esc(c.nome || '')}</b> ${fmtTel(c.telefone)}</div>
    <button onclick="alternarRobo('${c.telefone}', ${c.roboPausado})">${c.roboPausado ? '🤖 Devolver para o robô' : '🙋 Assumir conversa'}</button>`;
  const box = $('#chatMensagens');
  if (rolar || c.mensagens.length !== ultimoTamanho) {
    box.innerHTML = htmlMensagens(c.mensagens);
    box.scrollTop = box.scrollHeight;
    ultimoTamanho = c.mensagens.length;
  }
}
async function alternarRobo(tel, pausado) {
  await api('POST', `/api/conversas/${tel}/robo`, { ativo: pausado });
  toast(pausado ? 'Robô voltou a atender' : 'Você assumiu a conversa; o robô parou de responder');
  renderConversa();
}
$('#chatForm').onsubmit = async (e) => {
  e.preventDefault();
  const t = $('#chatTexto').value.trim();
  if (!t || !convAberta) return;
  $('#chatTexto').value = '';
  await api('POST', `/api/conversas/${convAberta}/mensagem`, { texto: t });
  renderConversa(true);
};

// ---------- Pedido balcão
let cdHoje = null, carrinho = [], selecoes = {};
const MAX_QTD = 200; // igual ao limite do servidor (src/pedidos.js)
const lerQtd = (v) => Math.min(MAX_QTD, Math.max(1, parseInt(v, 10) || 1));
let contasCache = [];
async function carregarBalcao() {
  const [cd, lista] = await Promise.all([api('GET', '/api/cardapio'), api('GET', '/api/contas')]);
  cdHoje = cd.cardapio;
  contasCache = lista;
  $('#dlPessoas').innerHTML = lista.filter((c) => c.tipo === 'pessoa').map((c) => `<option value="${esc(c.nome)}">${c.telefone ? fmtTel(c.telefone) : ''}</option>`).join('');
  $('#dlEmpresas').innerHTML = lista.filter((c) => c.tipo === 'empresa').map((c) => `<option value="${esc(c.nome)}"></option>`).join('');
  desenharBalcao();
  infoContaBalcao();
}
// Acha a conta do cliente digitado: empresa pelo nome, pessoa pelo telefone ou, se não tiver, pelo nome.
function contaDoBalcao() {
  if (modoEmpresa()) {
    const n = normNome($('#bEmpresa').value);
    return { conta: n && contasCache.find((c) => c.tipo === 'empresa' && normNome(c.nome) === n) };
  }
  const tel = telCompleto($('#bTel').value);
  if (tel) return { conta: contasCache.find((c) => c.tipo === 'pessoa' && telefonesDe(c).includes(tel)), porTelefone: true };
  const n = normNome($('#bNome').value);
  if (!n) return {};
  const iguais = contasCache.filter((c) => c.tipo === 'pessoa' && normNome(c.nome) === n);
  return iguais.length === 1 ? { conta: iguais[0] } : { varios: iguais.length > 1 ? iguais.length : 0 };
}
function infoContaBalcao() {
  const { conta, varios, porTelefone } = contaDoBalcao();
  const anotar = $('#bPag').value === 'Anotado';
  const nome = modoEmpresa() ? $('#bEmpresa').value.trim() : $('#bNome').value.trim();
  let t = '';
  if (conta) t = `📒 ${conta.tipo === 'empresa' ? 'Empresa' : 'Cliente'} com conta: <b>${esc(conta.nome)}</b>${conta.saldo > 0 ? ` · em aberto <b class="deve">${reais(conta.saldo)}</b>` : ''}`
    + (!porTelefone && !modoEmpresa() && !anotar ? ' · <span class="dica">pago na hora sem telefone não entra no histórico</span>' : '');
  else if (varios) t = `⚠ Há ${varios} clientes com esse nome: digite o telefone para escolher o certo.`;
  else if (anotar && nome) t = `Cliente novo: vai abrir uma conta para <b>${esc(nome)}</b>.`;
  $('#bContaInfo').innerHTML = t;
}
$('#bNome').oninput = () => {
  // Telefone que o sistema completou sozinho sai quando o nome muda (pode ser outra pessoa).
  if ($('#bTel').dataset.auto && $('#bTel').value === $('#bTel').dataset.auto) $('#bTel').value = '';
  $('#bTel').dataset.auto = '';
  infoContaBalcao();
};
$('#bTel').oninput = infoContaBalcao;
$('#bEmpresa').oninput = infoContaBalcao;
// Escolheu um cliente cadastrado: completa o telefone.
$('#bNome').onchange = () => {
  const { conta } = contaDoBalcao();
  if (conta?.telefone && !$('#bTel').value.trim()) $('#bTel').value = $('#bTel').dataset.auto = fmtTel(conta.telefone);
  infoContaBalcao();
};
let pagEscolhido = false; // a atendente mexeu na forma de pagamento
$('#bPag').onchange = () => { pagEscolhido = true; infoContaBalcao(); };
// Redesenha os cartões com o cardápio já carregado. É síncrono de propósito: o que foi digitado
// é guardado e devolvido na mesma hora, sem uma ida ao servidor no meio (que perdia ou duplicava teclas).
function desenharBalcao(v = {}) {
  if (!cdHoje) { $('#bItens').innerHTML = '<p class="aviso">Cadastre o cardápio de hoje na aba "Cardápio do dia".</p>'; return renderCarrinho(); }
  $('#bItens').innerHTML = cdHoje.itens.filter((i) => !i.esgotado).map((it) => {
    const s = (selecoes[it.id] ??= { tamanho: null, opcoes: {}, adicionais: [], qtd: 1 });
    return `<div class="item-card">
      <h4>${esc(it.nome)}</h4><div class="d">${esc(it.descricao)}</div>
      <div class="tams">${Object.entries(it.tamanhos).map(([t, p]) => `<button class="${s.tamanho === t ? 'sel' : ''}" onclick="sel('${it.id}','tamanho','${t}')">${t}<br><small>${reais(p)}</small></button>`).join('')}</div>
      ${it.opcoes.map((o) => `<div class="chips">${esc(o.nome)}: ${o.valores.map((v) => `<button class="${s.opcoes[o.nome] === v ? 'sel' : ''}" onclick="sel('${it.id}','opcao','${esc(o.nome)}','${esc(v)}')">${esc(v)}</button>`).join('')}</div>`).join('')}
      ${it.aceitaAdicionais && cdHoje.adicionais.length ? `<div class="chips">${cdHoje.adicionais.map((a, i) => `<button class="${s.adicionais.includes(i) ? 'sel' : ''}" onclick="sel('${it.id}','adic',${i})">+ ${esc(a.nome)} ${reais(a.preco)}</button>`).join('')}</div>` : ''}
      ${modoEmpresa() ? `<input id="func-${it.id}" class="func" placeholder="Nome do funcionário" style="margin-top:8px" onkeydown="if(event.key==='Enter')adicionar('${it.id}')">` : ''}
      <div class="linha" style="margin-top:8px"><input id="obs-${it.id}" placeholder="Obs.: sem abobrinha" style="flex:3" onkeydown="if(event.key==='Enter')adicionar('${it.id}')"><input id="qtd-${it.id}" type="number" min="1" max="${MAX_QTD}" value="1" style="flex:1;min-width:60px" onkeydown="if(event.key==='Enter')adicionar('${it.id}')"></div>
      <button class="primario grande" style="margin-top:8px;padding:8px" onclick="adicionar('${it.id}')">Adicionar</button>
    </div>`;
  }).join('');
  restaurar(v);
  renderCarrinho();
}
const modoEmpresa = () => $('#bEmpresaChk').checked;
// Guarda o que já foi digitado nos cartões, porque eles são redesenhados a cada clique.
function digitado() {
  const v = {};
  document.querySelectorAll('#bItens input[id]').forEach((el) => (v[el.id] = el.value));
  return v;
}
function restaurar(v) {
  for (const [id, val] of Object.entries(v)) { const el = document.getElementById(id); if (el) el.value = val; }
}
function sel(id, tipo, a, b) {
  const s = selecoes[id];
  if (tipo === 'tamanho') s.tamanho = a;
  if (tipo === 'opcao') s.opcoes[a] = b;
  if (tipo === 'adic') s.adicionais = s.adicionais.includes(a) ? s.adicionais.filter((x) => x !== a) : [...s.adicionais, a];
  desenharBalcao(digitado());
}
function adicionar(id) {
  const it = cdHoje.itens.find((i) => i.id === id), s = selecoes[id];
  if (!s.tamanho) return toast('Escolha o tamanho');
  const faltando = it.opcoes.find((o) => !s.opcoes[o.nome]);
  if (faltando) return toast('Escolha: ' + faltando.nome);
  const funcionario = modoEmpresa() ? document.getElementById('func-' + id).value.trim() : '';
  if (modoEmpresa() && !funcionario) { document.getElementById('func-' + id).focus(); return toast('Digite o nome do funcionário'); }
  carrinho.push({
    itemId: id, nome: it.nome, tamanho: s.tamanho, preco: it.tamanhos[s.tamanho], opcoes: { ...s.opcoes },
    adicionais: s.adicionais.map((i) => cdHoje.adicionais[i]), quantidade: lerQtd(document.getElementById('qtd-' + id).value),
    obs: document.getElementById('obs-' + id).value.trim(), funcionario,
  });
  const v = digitado();
  delete v['func-' + id]; delete v['obs-' + id]; delete v['qtd-' + id];
  if (modoEmpresa()) {
    // Empresa: mantém tamanho e opções para lançar o próximo funcionário rápido; adicionais são de cada um.
    s.adicionais = [];
    desenharBalcao(v);
    document.getElementById('func-' + id)?.focus();
    return;
  }
  selecoes[id] = { tamanho: null, opcoes: {}, adicionais: [], qtd: 1 };
  desenharBalcao(v);
}
function renderCarrinho() {
  const totalItem = (c) => (c.preco + c.adicionais.reduce((s, a) => s + a.preco, 0)) * c.quantidade;
  const qtd = carrinho.reduce((s, c) => s + c.quantidade, 0);
  $('#bQtd').textContent = qtd ? `${qtd} marmita${qtd > 1 ? 's' : ''}` : '';
  const comNome = modoEmpresa() || carrinho.some((c) => c.funcionario);
  $('#bCarrinho').innerHTML = carrinho.map((c, i) => `<div class="cit"><div>${comNome ? `<div class="func-nome">👤 ${esc(c.funcionario || '(sem nome)')}</div>` : ''}<b>${c.quantidade}x ${esc(c.nome)} ${c.tamanho}</b>
    <div class="dica">${esc([...Object.values(c.opcoes), ...c.adicionais.map((a) => '+ ' + a.nome)].join(', '))}${c.obs ? ` · <span class="obs" style="color:var(--verm)">${esc(c.obs)}</span>` : ''}</div></div>
    <div>${reais(totalItem(c))} <button onclick="carrinho.splice(${i},1);renderCarrinho()">✕</button></div></div>`).join('') || '<p class="dica">Nenhuma marmita adicionada.</p>';
  $('#bTotal').textContent = reais(carrinho.reduce((s, c) => s + totalItem(c), 0));
}
function mostrarEmpresa() {
  $('#bEmpresaWrap').hidden = !modoEmpresa();
  $('#bEmpresaDica').hidden = !modoEmpresa();
  // Empresa costuma acertar no fim do mês: já sugere "anotar" (a atendente pode trocar).
  const sugerida = modoEmpresa() ? 'Anotado' : 'Dinheiro';
  if (!pagEscolhido && $('#bPag').value !== sugerida) {
    $('#bPag').value = sugerida;
    if (modoEmpresa()) toast('Pagamento: Anotar na conta (pagar depois). Troque se a empresa pagar agora.');
  }
  infoContaBalcao();
}
mostrarEmpresa(); // o navegador pode lembrar a caixa marcada ao recarregar a página
$('#bEmpresaChk').onchange = () => {
  mostrarEmpresa();
  if (modoEmpresa() && carrinho.some((c) => !c.funcionario)) toast('As marmitas já adicionadas estão sem nome de funcionário');
  desenharBalcao(digitado());
};
let taxaPadrao = null;
$('#bTipo').onchange = () => {
  $('#bEndWrap').hidden = $('#bTipo').value !== 'entrega';
  if ($('#bTipo').value === 'entrega' && $('#bTaxa').value === '' && taxaPadrao != null) $('#bTaxa').value = taxaPadrao;
};
$('#bLancar').onclick = async () => {
  if (!carrinho.length) return toast('Adicione pelo menos uma marmita');
  if (modoEmpresa() && !$('#bEmpresa').value.trim()) return toast('Digite o nome da empresa');
  if (modoEmpresa() && carrinho.some((c) => !c.funcionario)) return toast('Tem marmita sem nome de funcionário: remova (✕) e adicione de novo com o nome');
  if (!modoEmpresa() && carrinho.some((c) => c.funcionario) && !confirm('As marmitas têm nome de funcionário, mas "Pedido de empresa" está desmarcado. Lançar assim mesmo?')) return;
  if (!$('#bNome').value.trim() && !(modoEmpresa() && $('#bEmpresa').value.trim())) return toast('Digite o nome do cliente');
  const { conta, varios, porTelefone } = contaDoBalcao();
  if ($('#bPag').value === 'Anotado' && varios) return toast('Há mais de um cliente com esse nome: digite o telefone');
  const tipo = $('#bTipo').value;
  const botao = $('#bLancar');
  botao.disabled = true; // evita lançar o mesmo pedido duas vezes com clique duplo
  let p;
  try {
    p = await api('POST', '/api/pedidos', {
      cliente: { nome: $('#bNome').value.trim(), telefone: $('#bTel').value.replace(/\D/g, '') },
      itens: carrinho, obs: $('#bObs').value.trim(),
      entrega: tipo === 'entrega' ? { tipo: 'entrega', endereco: $('#bEnd').value.trim(), taxa: $('#bTaxa').value === '' ? null : $('#bTaxa').value } : { tipo: 'balcao' },
      empresa: $('#bEmpresaChk').checked ? $('#bEmpresa').value.trim() : '',
      agendadoPara: $('#bEmpresaChk').checked ? $('#bHora').value : '',
      pagamento: { forma: $('#bPag').value },
      // Conta achada só pelo nome vale para anotar; pago na hora sem telefone não entra no cadastro de ninguém.
      contaId: conta && (porTelefone || modoEmpresa() || $('#bPag').value === 'Anotado') ? conta.id : null,
    });
  } catch (e) {
    return toast('Não lançou: ' + e.message);
  } finally {
    botao.disabled = false;
  }
  toast(`Pedido #${p.numero} lançado` + (p.erroImpressao ? ' (erro na impressão!)' : ''));
  idsConhecidos?.add(p.id); // não mostrar "Novo pedido!" por cima do aviso de lançado
  carrinho = []; ['#bNome', '#bTel', '#bObs', '#bEnd', '#bTaxa', '#bEmpresa', '#bHora'].forEach((s) => ($(s).value = ''));
  $('#bTel').dataset.auto = '';
  $('#bEmpresaChk').checked = false; pagEscolhido = false; mostrarEmpresa();
  selecoes = {};
  carregarBalcao(); atualizarPedidos();
};

// ---------- Caixa (fechamento do dia e resumo do mês)
const FORMAS_CAIXA = ['Dinheiro', 'Pix', 'Cartão'];
const SITUACAO = { recebido: '✅ Recebido', anotado: '📒 Anotado', pendente: '⏳ Não finalizado', cancelado: 'Cancelado' };
let caixaAtual = null;
// Só campo de digitar/escolher conta como "editando" (botão clicado não segura a tela).
const editando = (sel) => { const a = document.activeElement; return a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.closest(sel); };
async function carregarCaixa(forcar = false) {
  // Painel que fica aberto de um dia para o outro: se a data foi posta sozinha, acompanha o dia de hoje.
  if (!$('#xData').value || ($('#xData').dataset.auto && $('#xData').dataset.auto !== hojeISO())) {
    $('#xData').value = $('#xData').dataset.auto = hojeISO();
    limparFechamentoDigitado();
  }
  const data = $('#xData').value;
  const [r, mes] = await Promise.all([api('GET', '/api/caixa/' + data), api('GET', '/api/caixa/mes/' + data.slice(0, 7))]);
  caixaAtual = r;
  renderCaixa(r, forcar);
  renderMes(mes);
}
function renderCaixa(r, forcar) {
  const f = r.fechamento;
  $('#xSituacao').textContent = f ? `✅ Fechado às ${hora(f.em)}` : 'Caixa aberto';
  $('#xSituacao').className = 'tag ' + (f ? 'ok' : '');
  const avisos = [];
  if (r.mudouDepois) avisos.push('⚠ Algo mudou depois do fechamento (pedido, pagamento ou retirada). Confira e feche de novo.');
  if (r.pendentes.length) avisos.push(`Ainda tem ${r.pendentes.length} pedido(s) não finalizado(s), somando ${reais(r.pendente)}. Dê "Entregue" no quadro (ou cancele) antes de fechar.`);
  if (r.taxaAConfirmar.length) avisos.push(`Taxa de entrega a confirmar em ${r.taxaAConfirmar.map((p) => '#' + p.numero).join(', ')}: informe a taxa na lista de pedidos abaixo para entrar no total.`);
  $('#xAviso').innerHTML = avisos.map(esc).join('<br>');
  $('#xVendido').textContent = reais(r.vendido);
  $('#xVendidoDet').textContent = `${r.pedidos} pedidos · ${r.marmitas} marmitas`;
  $('#xRecebido').textContent = reais(r.recebidoVendas.total);
  $('#xAnotado').textContent = reais(r.anotado);
  $('#xAnotadoDet').textContent = r.anotadoPorConta.length ? `${r.anotadoPorConta.length} cliente(s)` : 'nada anotado';
  $('#xPendente').textContent = reais(r.pendente);
  $('#xPendenteDet').textContent = r.pendentes.length ? `${r.pendentes.length} pedido(s)` : 'tudo finalizado';
  $('#xContas').textContent = reais(r.recebidoContas.total);

  const formas = [...FORMAS_CAIXA, ...(r.entrou.Outro ? ['Outro'] : [])];
  $('#xFormas').innerHTML = formas.map((k) => `<tr><td>${k}</td><td class="num">${reais(r.recebidoVendas[k])}</td><td class="num">${reais(r.recebidoContas[k])}</td><td class="num"><b>${reais(r.entrou[k])}</b></td></tr>`).join('')
    + `<tr class="soma"><td>Total</td><td class="num">${reais(r.recebidoVendas.total)}</td><td class="num">${reais(r.recebidoContas.total)}</td><td class="num">${reais(r.entrou.total)}</td></tr>`;

  if (forcar || !editando('#xPedidos')) {
    $('#xPedidos').innerHTML = r.lista.map((p) => `<tr class="${p.situacao}">
      <td>#${p.numero}</td><td>${hora(p.criadoEm)}</td>
      <td>${p.contaId ? `<a href="#" onclick="abrirConta(${p.contaId});return false">${esc(p.nome)}</a>` : esc(p.nome)}</td>
      <td class="num">${reais(p.total)}${p.taxaAConfirmar ? `<br><button class="mini" onclick="informarTaxa(${p.id}, () => carregarCaixa(true))">+ taxa de entrega</button>` : ''}</td>
      <td>${p.situacao === 'cancelado' ? esc(nomeForma(p.forma)) : `<select onchange="trocarForma(${p.id}, this)">${['Dinheiro', 'Pix', 'Cartão', 'Anotado'].map((f) => `<option value="${f}" ${f === p.forma ? 'selected' : ''}>${f === 'Anotado' ? 'Anotado (pagar depois)' : f}</option>`).join('')}</select>`}</td>
      <td>${SITUACAO[p.situacao]}</td></tr>`).join('') || '<tr><td colspan="6" class="dica">Nenhum pedido neste dia.</td></tr>';
  }
  $('#xRecebimentos').innerHTML = r.recebimentos.map((x) => `<tr class="${x.cancelado ? 'cancelado' : ''}">
    <td>${hora(x.em)}</td><td><a href="#" onclick="abrirConta(${x.contaId});return false">${esc(x.nome)}</a></td><td>${esc(x.forma)}</td><td>${esc(x.obs)}</td>
    <td class="num">${reais(x.valor)}</td><td>${x.cancelado ? 'cancelado' : `<button onclick="cancelarRecebimento(${x.id})">✕</button>`}</td></tr>`).join('') || '<tr><td colspan="6" class="dica">Nenhuma conta paga neste dia.</td></tr>';

  if (!editando('#xAbertura')) $('#xAbertura').value = r.abertura ?? '';
  $('#xDinheiro').textContent = reais(r.gaveta.dinheiro);
  $('#xRetiradas').textContent = reais(r.gaveta.retiradas);
  $('#xSangrias').innerHTML = r.sangrias.map((s) => `<div class="linha-valor sub"><span>${hora(s.em)} · ${esc(s.descricao)}</span><span>${reais(s.valor)} <button onclick="removerSangria(${s.id})">✕</button></span></div>`).join('');
  $('#xEsperado').textContent = reais(r.gaveta.esperado);
  if (!editando('#xContado') && !$('#xContado').dataset.mexido) $('#xContado').value = f ? f.contado : '';
  if (!editando('#xObs') && !$('#xObs').dataset.mexido) $('#xObs').value = f?.obs || '';
  mostrarDiferenca();
  $('#xFechar').textContent = f ? 'Fechar de novo e imprimir' : 'Fechar caixa e imprimir';
  $('#xReabrir').hidden = !f;
  $('#xAnotadoLista').innerHTML = r.anotadoPorConta.map((a) => `<div class="linha-valor"><span>${a.contaId ? `<a href="#" onclick="abrirConta(${a.contaId});return false">${esc(a.nome)}</a>` : esc(a.nome)} <small class="dica">${a.pedidos} pedido(s)</small></span><b>${reais(a.valor)}</b></div>`).join('') || '<p class="dica">Nada anotado neste dia.</p>';
}
function mostrarDiferenca() {
  const v = $('#xContado').value;
  if (v === '' || !caixaAtual) { $('#xDiferenca').textContent = ''; $('#xDiferenca').className = 'diferenca'; return; }
  const d = Math.round((Number(v) - caixaAtual.gaveta.esperado) * 100) / 100;
  $('#xDiferenca').textContent = d === 0 ? 'Bateu certinho ✔' : d > 0 ? `Sobrou ${reais(d)}` : `Faltou ${reais(-d)}`;
  $('#xDiferenca').className = 'diferenca ' + (d === 0 ? 'ok' : d > 0 ? 'sobra' : 'falta');
}
function renderMes(m) {
  const [a, mm] = m.mes.split('-');
  $('#xMesNome').textContent = new Date(Number(a), Number(mm) - 1, 15).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const sem = (d) => new Date(d + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
  $('#xMes').innerHTML = m.dias.map((d) => `<tr class="clicavel ${d.data === $('#xData').value ? 'sel' : ''}" onclick="irParaDia('${d.data}')">
    <td>${dataBR(d.data).slice(0, 5)} <small class="dica">${sem(d.data)}</small></td><td class="num">${d.pedidos}</td><td class="num">${reais(d.vendido)}</td><td class="num">${reais(d.recebido)}</td>
    <td class="num">${reais(d.anotado)}</td><td class="num">${reais(d.recebidoContas)}</td><td class="num">${reais(d.entrou.total)}</td>
    <td>${d.fechado ? (d.mudouDepois ? '⚠ mudou depois' : d.diferenca ? `✅ <span class="${d.diferenca > 0 ? 'sobra' : 'falta'}">${d.diferenca > 0 ? 'sobrou' : 'faltou'} ${reais(Math.abs(d.diferenca))}</span>` : '✅') : d.pendente ? '⏳ aberto' : '—'}</td></tr>`).join('') || '<tr><td colspan="8" class="dica">Sem movimento neste mês.</td></tr>';
  const t = m.total;
  $('#xMesTotal').innerHTML = `<tr class="soma"><td>Total</td><td class="num">${t.pedidos}</td><td class="num">${reais(t.vendido)}</td><td class="num">${reais(t.recebido)}</td><td class="num">${reais(t.anotado)}</td><td class="num">${reais(t.recebidoContas)}</td><td class="num">${reais(t.entrou.total)}</td><td></td></tr>`;
}
function limparFechamentoDigitado() {
  $('#xContado').dataset.mexido = ''; $('#xObs').dataset.mexido = '';
  $('#xContado').value = ''; $('#xObs').value = '';
}
function irParaDia(data) {
  $('#xData').value = data;
  $('#xData').dataset.auto = data === hojeISO() ? data : '';
  limparFechamentoDigitado();
  carregarCaixa();
}
$('#xData').onchange = () => irParaDia($('#xData').value);
$('#xContado').oninput = () => { $('#xContado').dataset.mexido = '1'; mostrarDiferenca(); };
$('#xObs').oninput = () => { $('#xObs').dataset.mexido = '1'; };
$('#xAbertura').onchange = async () => {
  try { renderCaixa(caixaAtual = await api('PUT', `/api/caixa/${$('#xData').value}/abertura`, { valor: $('#xAbertura').value })); toast('Troco inicial salvo'); } catch (e) { toast('Erro: ' + e.message); }
};
$('#xSangAdd').onclick = async () => {
  const b = $('#xSangAdd');
  if (b.disabled) return; // clique duplo não grava a retirada duas vezes
  b.disabled = true;
  try {
    caixaAtual = await api('POST', `/api/caixa/${$('#xData').value}/sangrias`, { valor: $('#xSangValor').value, descricao: $('#xSangDesc').value });
    $('#xSangValor').value = ''; $('#xSangDesc').value = '';
    renderCaixa(caixaAtual);
  } catch (e) { toast('Erro: ' + e.message); } finally { b.disabled = false; }
};
$('#xSangDesc').onkeydown = (e) => { if (e.key === 'Enter') $('#xSangAdd').click(); };
async function removerSangria(id) {
  if (!confirm('Apagar esta retirada?')) return;
  try { renderCaixa(caixaAtual = await api('DELETE', `/api/caixa/${$('#xData').value}/sangrias/${id}`)); } catch (e) { toast('Erro: ' + e.message); }
}
async function trocarForma(id, el) {
  el.blur();
  if (caixaAtual?.fechamento && !confirm('O caixa deste dia já foi fechado. Trocar a forma de pagamento mesmo assim?')) return carregarCaixa(true);
  const corpo = { forma: el.value };
  // Anotar pedido sem cadastro e com nome repetido: a atendente escolhe de quem é.
  const linha = caixaAtual?.lista.find((p) => p.id === id);
  if (el.value === 'Anotado' && linha && !linha.contaId) {
    const iguais = (await api('GET', '/api/contas?busca=' + encodeURIComponent(linha.nome))).filter((c) => c.tipo === 'pessoa' && normNome(c.nome) === normNome(linha.nome));
    if (iguais.length > 1) {
      const n = prompt(`Há ${iguais.length} clientes chamados "${linha.nome}". Anotar na conta de qual?\n\n${iguais.map((c, i) => `${i + 1} - ${c.nome} ${c.telefone ? fmtTel(c.telefone) : '(sem telefone)'}${c.saldo > 0 ? ' · deve ' + reais(c.saldo) : ''}`).join('\n')}`);
      const escolhido = iguais[Number(n) - 1];
      if (!escolhido) { toast('Nada mudou'); return carregarCaixa(true); }
      corpo.contaId = escolhido.id;
    }
  }
  try { await api('POST', `/api/pedidos/${id}/pagamento`, corpo); toast('Forma de pagamento trocada'); } catch (e) { toast('Erro: ' + e.message); }
  carregarCaixa(true);
}
async function cancelarRecebimento(id) {
  if (!confirm('Cancelar este pagamento? O valor volta a ficar em aberto na conta do cliente.')) return;
  try { await api('DELETE', `/api/recebimentos/${id}`); toast('Pagamento cancelado'); } catch (e) { toast('Erro: ' + e.message); }
  if (abaAtual === 'caixa') carregarCaixa(); else carregarClientes();
}
$('#xFechar').onclick = async () => {
  const r = caixaAtual;
  if (!r) return;
  if ($('#xContado').value === '') { $('#xContado').focus(); return toast('Conte o dinheiro da gaveta e digite o valor'); }
  if (r.pendentes.length && !confirm(`Ainda tem ${r.pendentes.length} pedido(s) não finalizado(s). Fechar o caixa assim mesmo?`)) return;
  const botao = $('#xFechar');
  botao.disabled = true;
  try {
    const res = await api('POST', `/api/caixa/${$('#xData').value}/fechar`, { contado: $('#xContado').value, obs: $('#xObs').value });
    $('#xContado').dataset.mexido = ''; $('#xObs').dataset.mexido = '';
    toast(res.erroImpressao ? 'Caixa fechado, mas a impressora deu erro: ' + res.erroImpressao : 'Caixa fechado e resumo impresso');
  } catch (e) { toast('Erro: ' + e.message); } finally { botao.disabled = false; }
  carregarCaixa();
};
$('#xReabrir').onclick = async () => {
  if (!confirm('Reabrir o caixa deste dia? O fechamento salvo será apagado.')) return;
  try { await api('POST', `/api/caixa/${$('#xData').value}/reabrir`); } catch (e) { toast('Erro: ' + e.message); }
  carregarCaixa();
};
$('#xImprimir').onclick = async () => {
  try { await api('POST', `/api/caixa/${$('#xData').value}/imprimir`); toast('Resumo enviado para a impressora'); } catch (e) { toast('Erro: ' + e.message); }
};

// ---------- Clientes e contas (histórico e anotado para pagar depois)
let contaAberta = null, extratoAtual = null, contasLista = [];
function mesDosClientes() {
  const atual = hojeISO().slice(0, 7);
  if (!$('#kMes').value || ($('#kMes').dataset.auto && $('#kMes').dataset.auto !== atual)) $('#kMes').value = $('#kMes').dataset.auto = atual;
}
async function carregarClientes() {
  mesDosClientes();
  const q = new URLSearchParams({ busca: $('#kBusca').value.trim(), mes: $('#kMes').value, abertas: $('#kAbertas').checked ? '1' : '' });
  const lista = await api('GET', '/api/contas?' + q);
  contasLista = lista;
  const aberto = lista.reduce((s, c) => s + Math.max(0, c.saldo), 0);
  $('#kTotais').innerHTML = `${lista.length} cliente(s) · em aberto: <b class="deve">${reais(aberto)}</b>`;
  $('#kLista').innerHTML = lista.map((c) => `<tr class="clicavel ${c.id === contaAberta ? 'sel' : ''}" onclick="abrirConta(${c.id})">
    <td>${c.tipo === 'empresa' ? '🏢' : '👤'} <b>${esc(c.nome)}</b>${c.anotar ? ' <span class="tag" title="Pode anotar pelo WhatsApp">📒</span>' : ''}<br><small class="dica">${c.telefone ? fmtTel(c.telefone) : ''}</small></td>
    <td class="num">${c.pedidosMes || ''}</td><td class="num">${c.totalMes ? reais(c.totalMes) : ''}</td>
    <td class="num">${c.saldo > 0 ? `<b class="deve">${reais(c.saldo)}</b>` : c.saldo < 0 ? `<span class="credito">crédito ${reais(-c.saldo)}</span>` : '—'}</td>
    <td>${c.ultimoPedido ? new Date(c.ultimoPedido).toLocaleDateString('pt-BR') : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="dica">Nenhum cliente. Os clientes aparecem aqui quando fazem pedido pelo WhatsApp, quando o pedido tem empresa ou telefone, ou quando é anotado.</td></tr>';
  if (contaAberta) abrirConta(contaAberta, false);
}
let buscaTimer;
$('#kBusca').oninput = () => { clearTimeout(buscaTimer); buscaTimer = setTimeout(carregarClientes, 250); };
$('#kMes').onchange = () => { $('#kMes').dataset.auto = ''; carregarClientes(); };
$('#kAbertas').onchange = carregarClientes;
const nomeMes = (mes) => { const [a, m] = mes.split('-'); return new Date(Number(a), Number(m) - 1, 15).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }); };
async function abrirConta(id, irParaAba = true) {
  if (!id) return;
  if (irParaAba && abaAtual !== 'clientes') { contaAberta = id; return abrirAba('clientes'); }
  contaAberta = id;
  mesDosClientes();
  let ex;
  try { ex = await api('GET', `/api/contas/${id}/extrato?mes=${$('#kMes').value}`); } catch { contaAberta = null; $('#kDetalhe').hidden = true; return; }
  extratoAtual = ex;
  document.querySelectorAll('#kLista tr').forEach((tr) => tr.classList.toggle('sel', tr.getAttribute('onclick') === `abrirConta(${id})`));
  const c = ex.conta, t = ex.totais;
  const itensTxt = (p) => p.itens.map((it) => `${it.quantidade}x ${esc(it.nome)} ${it.tamanho}${it.funcionario ? ` <span class="func-nome">${esc(it.funcionario)}</span>` : ''}`).join('<br>');
  $('#kDetalhe').hidden = false;
  $('#kDetalhe').innerHTML = `
    <div class="cab-conta"><h3>${c.tipo === 'empresa' ? '🏢' : '👤'} ${esc(c.nome)}</h3>
      <div><button onclick="editarConta(${c.id})">Editar</button> <button onclick="contaAberta=null;$('#kDetalhe').hidden=true;carregarClientes()">✕</button></div></div>
    <div class="dica">${c.telefone ? fmtTel(c.telefone) + ' · ' : ''}${c.tipo === 'empresa' ? 'Empresa · pedidos lançados no balcão' : c.anotar ? '📒 Pode anotar pelo WhatsApp' : 'Anota só pelo balcão'}${c.obs ? ' · ' + esc(c.obs) : ''}</div>
    <div class="tiles mini">
      <div class="tile"><span>Pedidos em ${nomeMes(ex.mes)}</span><b>${reais(t.total)}</b><small>${t.pedidos} pedidos · ${t.marmitas} marmitas</small></div>
      <div class="tile anot"><span>Anotado no mês</span><b>${reais(t.anotado)}</b><small>pago na hora: ${reais(t.pagoNaHora)}${t.naoFinalizado ? ` · não finalizado: ${reais(t.naoFinalizado)}` : ''}</small></div>
      <div class="tile ok"><span>Pagamentos no mês</span><b>${reais(t.recebido)}</b><small>${ex.recebimentos.length} pagamento(s)</small></div>
      <div class="tile ${ex.saldoHoje > 0 ? 'pend' : ''}"><span>Em aberto hoje</span><b>${ex.saldoHoje < 0 ? 'crédito ' + reais(-ex.saldoHoje) : reais(ex.saldoHoje)}</b><small>tudo que falta pagar</small></div>
    </div>
    <div class="linha-valor sub"><span>Saldo do mês: anterior ${reais(ex.saldoAnterior)} + anotado ${reais(t.anotado)} − pago ${reais(t.recebido)}</span><b>= ${reais(ex.saldoFinal)}</b></div>
    <div class="acoes-conta">
      <button class="primario" onclick="abrirReceber()">💰 Receber pagamento</button>
      <button onclick="window.open('extrato.html?conta=${c.id}&mes=${ex.mes}', '_blank')">📄 Extrato do mês (imprimir ou PDF)</button>
      <button onclick="copiarExtrato()">📋 Copiar resumo para o WhatsApp</button>
    </div>
    <h4>Pedidos de ${nomeMes(ex.mes)}</h4>
    <table class="tabela"><thead><tr><th>Dia</th><th>Pedido</th><th>Marmitas</th><th>Pagamento</th><th class="num">Valor</th></tr></thead><tbody>
      ${ex.pedidos.map((p) => `<tr><td>${dataBR(p.data).slice(0, 5)}</td><td>#${p.numero}</td><td>${itensTxt(p)}</td><td>${esc(nomeForma(p.forma))}</td><td class="num">${reais(p.total)}</td></tr>`).join('') || '<tr><td colspan="5" class="dica">Nenhum pedido neste mês.</td></tr>'}
    </tbody></table>
    ${ex.porFuncionario ? `<h4>Por funcionário</h4><table class="tabela"><thead><tr><th>Funcionário</th><th class="num">Marmitas</th><th class="num">Valor</th></tr></thead><tbody>
      ${ex.porFuncionario.map((f) => `<tr><td>${esc(f.nome)}</td><td class="num">${f.marmitas}</td><td class="num">${reais(f.valor)}</td></tr>`).join('')}
      ${t.taxas ? `<tr><td>Taxas de entrega</td><td></td><td class="num">${reais(t.taxas)}</td></tr>` : ''}</tbody></table>` : ''}
    <h4>Pagamentos recebidos em ${nomeMes(ex.mes)}</h4>
    <table class="tabela"><thead><tr><th>Dia</th><th>Forma</th><th>Obs.</th><th class="num">Valor</th><th></th></tr></thead><tbody>
      ${ex.recebimentos.map((r) => `<tr><td>${dataBR(r.data).slice(0, 5)}</td><td>${esc(r.forma)}</td><td>${esc(r.obs)}</td><td class="num">${reais(r.valor)}</td><td><button onclick="cancelarRecebimento(${r.id})" title="Cancelar pagamento lançado errado">✕</button></td></tr>`).join('') || '<tr><td colspan="5" class="dica">Nenhum pagamento neste mês.</td></tr>'}
    </tbody></table>`;
}
function abrirReceber() {
  const ex = extratoAtual;
  if (!ex) return; // ainda carregando depois do último pagamento
  $('#rCliente').textContent = `${ex.conta.nome} · em aberto: ${reais(Math.max(0, ex.saldoHoje))}`;
  $('#rValor').value = ex.saldoHoje > 0 ? ex.saldoHoje.toFixed(2) : '';
  $('#rForma').value = 'Pix';
  $('#rObs').value = `Referente a ${nomeMes(ex.mes)}`;
  $('#fReceber').dataset.conta = ex.conta.id;
  $('#dlgReceber').returnValue = ''; // fechar com Esc não pode repetir o último "Receber"
  $('#dlgReceber').showModal();
  $('#rValor').select();
}
$('#dlgReceber').onclose = async () => {
  if ($('#dlgReceber').returnValue !== 'ok') return;
  extratoAtual = null; // até recarregar, não deixa abrir de novo com o saldo antigo
  document.activeElement?.blur();
  try {
    const r = await api('POST', `/api/contas/${$('#fReceber').dataset.conta}/recebimentos`, { valor: $('#rValor').value, forma: $('#rForma').value, obs: $('#rObs').value });
    toast(`Recebido ${reais(r.valor)} (${r.forma}). Já entrou no caixa de hoje.`);
  } catch (e) { toast('Erro: ' + e.message); }
  carregarClientes();
};
function editarConta(id) {
  const c = id ? (contasLista.find((x) => x.id === id) || extratoAtual?.conta) : null;
  $('#ctTitulo').textContent = c ? 'Editar cliente' : 'Novo cliente';
  $('#ctTipo').value = c?.tipo || 'pessoa';
  $('#ctNome').value = c?.nome || '';
  $('#ctTel').value = c?.telefone ? fmtTel(c.telefone) : '';
  $('#ctAnotar').checked = !!c?.anotar;
  $('#ctAnotarWrap').hidden = $('#ctTipo').value === 'empresa';
  $('#ctObs').value = c?.obs || '';
  $('#fConta').dataset.id = c?.id || '';
  $('#ctExtra').hidden = !c;
  if (c) $('#ctJuntar').innerHTML = '<option value="">Escolha o cadastro certo...</option>' + contasLista.filter((x) => x.id !== c.id).map((x) => `<option value="${x.id}">${x.tipo === 'empresa' ? '🏢' : '👤'} ${esc(x.nome)}${x.telefone ? ' · ' + fmtTel(x.telefone) : ''}</option>`).join('');
  $('#dlgConta').returnValue = '';
  $('#dlgConta').showModal();
}
$('#kNovo').onclick = () => editarConta(null);
$('#ctTipo').onchange = () => ($('#ctAnotarWrap').hidden = $('#ctTipo').value === 'empresa');
$('#dlgConta').onclose = async () => {
  if ($('#dlgConta').returnValue !== 'ok') return;
  const id = Number($('#fConta').dataset.id) || undefined;
  try {
    const c = await api('POST', '/api/contas', { id, tipo: $('#ctTipo').value, nome: $('#ctNome').value, telefone: $('#ctTel').value, anotar: $('#ctAnotar').checked, obs: $('#ctObs').value });
    toast('Cliente salvo');
    contaAberta = c.id;
  } catch (e) {
    // Mantém o que foi digitado para corrigir.
    toast('Erro: ' + e.message);
    $('#dlgConta').returnValue = '';
    return $('#dlgConta').showModal();
  }
  carregarClientes();
};
$('#ctJuntarBtn').onclick = async () => {
  const origem = Number($('#fConta').dataset.id), destino = Number($('#ctJuntar').value);
  if (!destino) return toast('Escolha com qual cadastro juntar');
  const nomeDestino = $('#ctJuntar').selectedOptions[0].textContent;
  if (!confirm(`Passar os pedidos e pagamentos de "${$('#ctNome').value}" para "${nomeDestino}" e apagar este cadastro?`)) return;
  try { await api('POST', `/api/contas/${origem}/juntar`, { destinoId: destino }); contaAberta = destino; toast('Cadastros juntados'); $('#dlgConta').close(); } catch (e) { toast('Erro: ' + e.message); }
  carregarClientes();
};
$('#ctExcluir').onclick = async () => {
  if (!confirm('Excluir este cadastro?')) return;
  try { await api('DELETE', '/api/contas/' + $('#fConta').dataset.id); contaAberta = null; $('#kDetalhe').hidden = true; toast('Cadastro excluído'); $('#dlgConta').close(); } catch (e) { toast('Erro: ' + e.message); }
  carregarClientes();
};
async function copiarExtrato() {
  try { await navigator.clipboard.writeText(extratoAtual.texto); toast('Resumo copiado: cole na conversa do cliente'); } catch { toast('Não foi possível copiar'); }
}

// ---------- Cardápio
let edicao = null, modelos = {};
const hojeISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
async function carregarCardapio() {
  if (!$('#cData').value) $('#cData').value = hojeISO();
  const r = await api('GET', '/api/cardapio?data=' + $('#cData').value);
  modelos = r.modelos;
  $('#cModelo').innerHTML = Object.entries(modelos).map(([k, m]) => `<option value="${k}" ${k === r.modeloSugerido ? 'selected' : ''}>${m.nomeModelo}</option>`).join('');
  edicao = r.cardapio ? structuredClone(r.cardapio) : structuredClone(modelos[r.modeloSugerido]);
  if (!r.cardapio) toast('Ainda não salvo: carreguei o modelo ' + modelos[r.modeloSugerido].nomeModelo);
  renderEdicao();
}
$('#cData').onchange = carregarCardapio;
$('#cUsarModelo').onclick = () => { edicao = structuredClone(modelos[$('#cModelo').value]); renderEdicao(); };
$('#cCopiarOntem').onclick = async () => {
  for (let i = 1; i <= 14; i++) {
    const d = new Date($('#cData').value + 'T12:00:00'); d.setDate(d.getDate() - i);
    const r = await api('GET', '/api/cardapio?data=' + d.toISOString().slice(0, 10));
    if (r.cardapio) { edicao = structuredClone(r.cardapio); renderEdicao(); return toast('Copiado de ' + d.toLocaleDateString('pt-BR')); }
  }
  toast('Nenhum cardápio nos últimos 14 dias');
};
function renderEdicao() {
  $('#cItens').innerHTML = edicao.itens.map((it, i) => `<div class="ed-item">
    <div class="linha"><label style="flex:3">Nome<input value="${esc(it.nome)}" oninput="edicao.itens[${i}].nome=this.value;previa()"></label>
      <label style="flex:0;min-width:auto;align-self:end"><input type="checkbox" ${it.esgotado ? 'checked' : ''} onchange="edicao.itens[${i}].esgotado=this.checked;previa()"> Esgotado</label>
      <button style="flex:0;min-width:auto;align-self:end" onclick="edicao.itens.splice(${i},1);renderEdicao()">Remover</button></div>
    <label>Descrição (o que vem na marmita)<input value="${esc(it.descricao)}" oninput="edicao.itens[${i}].descricao=this.value;previa()"></label>
    <div class="linha">${['P', 'M', 'G'].map((t) => `<label>Preço ${t}<input type="number" step="0.5" value="${it.tamanhos[t] ?? ''}" placeholder="não tem" oninput="precoTam(${i},'${t}',this.value)"></label>`).join('')}</div>
    <label>Opções (ex.: Feijão: Preto, Branco)<input value="${esc((it.opcoes || []).map((o) => o.nome + ': ' + o.valores.join(', ')).join(' | '))}" onchange="opcoesTxt(${i},this.value)"></label>
    <label><input type="checkbox" ${it.aceitaAdicionais !== false ? 'checked' : ''} onchange="edicao.itens[${i}].aceitaAdicionais=this.checked"> Aceita adicionais</label>
  </div>`).join('');
  $('#cAdicionais').innerHTML = edicao.adicionais.map((a, i) => `<div class="ed-adic"><input value="${esc(a.nome)}" oninput="edicao.adicionais[${i}].nome=this.value;previa()"><input type="number" step="0.5" value="${a.preco}" oninput="edicao.adicionais[${i}].preco=Number(this.value);previa()"><button onclick="edicao.adicionais.splice(${i},1);renderEdicao()">✕</button></div>`).join('');
  $('#cAcomp').value = edicao.acompanhamentos || '';
  $('#cAviso').value = edicao.aviso || '';
  previa();
}
function precoTam(i, t, v) { const tm = edicao.itens[i].tamanhos; if (v === '') delete tm[t]; else tm[t] = Number(v); previa(); }
function opcoesTxt(i, v) {
  edicao.itens[i].opcoes = v.split('|').map((p) => p.split(':')).filter((p) => p.length === 2).map(([n, vs]) => ({ nome: n.trim(), valores: vs.split(',').map((x) => x.trim()).filter(Boolean) }));
}
$('#cAcomp').oninput = () => { edicao.acompanhamentos = $('#cAcomp').value; previa(); };
$('#cAviso').oninput = () => { edicao.aviso = $('#cAviso').value; previa(); };
$('#cAddItem').onclick = () => { edicao.itens.push({ nome: '', descricao: '', tamanhos: { P: 0, M: 0, G: 0 }, opcoes: [], aceitaAdicionais: true }); renderEdicao(); };
$('#cAddAdic').onclick = () => { edicao.adicionais.push({ nome: '', preco: 0 }); renderEdicao(); };
function previa() {
  const L = [`🍽️ *Marmitaria Tempero da Família*`, `*Cardápio de ${new Date($('#cData').value + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' })}*`, ''];
  for (const it of edicao.itens.filter((i) => !i.esgotado && i.nome)) {
    L.push(`🍱 *${it.nome}*`); if (it.descricao) L.push(it.descricao);
    L.push(Object.entries(it.tamanhos).map(([t, p]) => `${t} ${reais(p)}`).join('  |  ')); L.push('');
  }
  if (edicao.acompanhamentos) L.push('🥗 ' + edicao.acompanhamentos, '');
  if (edicao.adicionais.length) L.push('➕ *Adicionais:* ' + edicao.adicionais.map((a) => `${a.nome} ${reais(a.preco)}`).join(', '), '');
  if (edicao.aviso) L.push(`⚠️ _${edicao.aviso}_`);
  $('#cPrevia').innerHTML = whats(L.join('\n'));
  textoCardapio = L.join('\n');
  desenharImagem();
}
let textoCardapio = '', numeroPedidos = '';
api('GET', '/api/config').then((c) => { numeroPedidos = c.numeroPedidos || ''; taxaPadrao = c.taxaEntrega ?? null; });

// Imagem 1080x1920 (formato do Status) desenhada no próprio navegador.
function desenharImagem() {
  const cv = $('#cCanvas'), g = cv.getContext('2d');
  const W = 1080, H = 1920, VERM = '#c8102e';
  const itens = edicao.itens.filter((i) => !i.esgotado && i.nome);
  const dataTxt = new Date($('#cData').value + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });
  const quebrar = (txt, larg) => {
    const out = []; let l = '';
    for (const p of String(txt).split(' ')) { if (g.measureText(l ? l + ' ' + p : p).width > larg && l) { out.push(l); l = p; } else l = l ? l + ' ' + p : p; }
    if (l) out.push(l); return out;
  };
  // Desenha (ou só mede, quando desenhar=false) o miolo com fator de escala f.
  const miolo = (f, desenhar) => {
    let y = 430;
    const fonte = (peso, tam) => (g.font = `${peso} ${Math.round(tam * f)}px system-ui, "Segoe UI", sans-serif`);
    for (const it of itens) {
      fonte(800, 62); g.fillStyle = '#222';
      for (const l of quebrar(it.nome, 920)) { y += 70 * f; if (desenhar) g.fillText(l, 80, y); }
      if (it.descricao) {
        fonte(400, 38); g.fillStyle = '#555';
        for (const l of quebrar(it.descricao, 920)) { y += 48 * f; if (desenhar) g.fillText(l, 80, y); }
      }
      y += 26 * f; fonte(800, 42);
      let x = 80;
      for (const [t, p] of Object.entries(it.tamanhos)) {
        const txt = `${t}  ${reais(p)}`, w = g.measureText(txt).width + 48 * f;
        if (x > 80 && x + w > W - 60) { x = 80; y += 88 * f; } // quebra a linha de preços se não couber
        if (desenhar) { g.fillStyle = VERM; g.beginPath(); g.roundRect(x, y, w, 70 * f, 35 * f); g.fill(); g.fillStyle = '#fff'; g.fillText(txt, x + 24 * f, y + 51 * f); }
        x += w + 18;
      }
      y += 70 * f + 60 * f;
    }
    if (edicao.acompanhamentos) { fonte(400, 38); g.fillStyle = '#333'; for (const l of quebrar(edicao.acompanhamentos, 920)) { y += 48 * f; if (desenhar) g.fillText(l, 80, y); } y += 30 * f; }
    if (edicao.adicionais.length) {
      fonte(700, 42); g.fillStyle = '#222'; y += 50 * f; if (desenhar) g.fillText('Adicionais', 80, y);
      fonte(400, 40);
      for (const l of quebrar(edicao.adicionais.map((a) => `${a.nome} ${reais(a.preco)}`.replace(/ /g, '\u00a0')).join('  •  '), 920)) { y += 52 * f; if (desenhar) g.fillText(l, 80, y); }
      y += 30 * f;
    }
    if (edicao.aviso) { fonte('italic 400', 32); g.fillStyle = '#777'; for (const l of quebrar(edicao.aviso, 920)) { y += 42 * f; if (desenhar) g.fillText(l, 80, y); } }
    return y;
  };
  let f = 1.25;
  while (f > 0.5 && miolo(f, false) > H - 300) f -= 0.05;

  g.fillStyle = '#fbf7f2'; g.fillRect(0, 0, W, H);
  g.fillStyle = VERM; g.fillRect(0, 0, W, 360);
  g.strokeStyle = '#fff'; g.lineWidth = 6; g.beginPath(); g.arc(W / 2, 110, 62, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#fff'; g.textAlign = 'center';
  g.font = '64px system-ui'; g.fillText('🍴', W / 2, 133);
  g.font = '800 60px system-ui, "Segoe UI", sans-serif'; g.fillText('Tempero da Família', W / 2, 250);
  g.font = '400 40px system-ui, "Segoe UI", sans-serif'; g.fillText('Cardápio de ' + dataTxt, W / 2, 315);
  g.textAlign = 'left';
  miolo(f, true);
  g.fillStyle = VERM; g.fillRect(0, H - 220, W, 220);
  g.fillStyle = '#fff'; g.textAlign = 'center';
  g.font = '800 58px system-ui, "Segoe UI", sans-serif'; g.fillText('Peça pelo WhatsApp', W / 2, H - 125);
  g.font = '700 50px system-ui, "Segoe UI", sans-serif'; g.fillText(numeroPedidos || '(45) 99862-2219', W / 2, H - 55);
  g.textAlign = 'left';
}
$('#cImagem').onclick = () => {
  const a = document.createElement('a');
  a.download = `cardapio-${$('#cData').value}.png`;
  a.href = $('#cCanvas').toDataURL('image/png');
  a.click();
};
$('#cCopiarTexto').onclick = async () => {
  const txt = textoCardapio + (numeroPedidos ? `\n\n📲 Peça pelo WhatsApp: ${numeroPedidos}` : '');
  try { await navigator.clipboard.writeText(txt); toast('Texto copiado'); } catch { toast('Não foi possível copiar'); }
};
$('#cSalvar').onclick = async () => {
  await api('PUT', '/api/cardapio', { ...edicao, data: $('#cData').value });
  toast('Cardápio salvo'); carregarCardapio();
};

// ---------- Contatos e envio
async function carregarContatos() {
  const lista = await api('GET', '/api/contatos');
  $('#qtContatos').textContent = lista.length;
  $('#tContatos').innerHTML = lista.map((c) => `<tr><td>${esc(c.nome)}</td><td>${fmtTel(c.telefone)}</td>
    <td><input type="checkbox" ${c.recebeCardapio !== false ? 'checked' : ''} onchange="api('POST','/api/contatos',{telefone:'${c.telefone}',recebeCardapio:this.checked})"></td>
    <td><button onclick="if(confirm('Remover contato?')) api('DELETE','/api/contatos/${c.telefone}').then(carregarContatos)">✕</button></td></tr>`).join('');
  const st = await api('GET', '/api/disparo');
  const d = st.emAndamento || st.historico[0];
  $('#dStatus').textContent = d ? `${st.emAndamento ? 'Enviando' : 'Último envio'} (${d.origem}, ${new Date(d.inicio).toLocaleString('pt-BR')}): ${d.enviados} de ${d.total} enviados${d.falhas ? `, ${d.falhas} falhas` : ''}` : '';
}
$('#impBtn').onclick = async () => {
  const r = await api('POST', '/api/contatos/importar', { texto: $('#impTexto').value });
  toast(`${r.importados} contatos importados`); $('#impTexto').value = ''; carregarContatos();
};
$('#dEnviar').onclick = async () => {
  if (!confirm('Enviar o cardápio de hoje para todos os contatos que recebem?')) return;
  try { await api('POST', '/api/disparo'); toast('Envio iniciado'); } catch (e) { toast(e.message); }
  carregarContatos();
};

// ---------- Simulador
async function carregarSimulador() {
  const tel = '55' + $('#sTel').value.replace(/\D/g, '').replace(/^55/, '');
  try { const c = await api('GET', '/api/conversas/' + tel); renderSim(c); } catch { $('#sMensagens').innerHTML = '<p class="dica">Mande um "oi" para começar.</p>'; }
}
function renderSim(c) {
  const box = $('#sMensagens');
  // No simulador o lado do cliente fica à direita, como no celular dele.
  box.innerHTML = c.mensagens.map((m) => `<div class="msg ${m.de === 'cliente' ? 'robo' : 'cliente'}">${whats(m.texto)}<span class="h">${hora(m.em)}</span></div>`).join('');
  box.scrollTop = box.scrollHeight;
}
$('#sForm').onsubmit = async (e) => {
  e.preventDefault();
  const texto = $('#sTexto').value; if (!texto.trim()) return;
  $('#sTexto').value = '';
  const c = await api('POST', '/api/simular', { telefone: $('#sTel').value, nome: $('#sNome').value, texto });
  renderSim(c); atualizarPedidos();
};

// ---------- Configurações
async function carregarConfig() {
  const c = await api('GET', '/api/config');
  $('#cfAceitando').checked = c.aceitandoPedidos; $('#cfTaxa').value = c.taxaEntrega ?? ''; $('#cfPix').value = c.chavePix || '';
  $('#cfDispAuto').checked = c.disparo.automatico; $('#cfDispApi').checked = !!c.disparo.pelaApiOficial; $('#cfNumero').value = c.numeroPedidos || ''; $('#cfDispHora').value = c.disparo.horario;
  $('#cfImpModo').value = c.impressora.modo; $('#cfImpHost').value = c.impressora.host; $('#cfImpComp').value = c.impressora.compartilhamento;
  const w = c.whatsapp || {};
  $('#cfWModo').value = w.modo || 'simulador'; $('#cfW360').value = w.apiKey360 || ''; $('#cfWChave').value = w.chaveWebhook || ''; $('#cfWUrl').value = w.urlPublica || '';
  mostrarCamposWhats(); $('#cfWPhone').value = w.phoneNumberId || ''; $('#cfWToken').value = w.token || '';
  $('#cfWSecret').value = w.appSecret || ''; $('#cfWVerify').value = w.verifyToken || ''; $('#cfWModelo').value = w.templateCardapio?.nome || '';
  $('#cfImpCols').value = c.impressora.colunas; $('#cfImpVias').value = c.impressora.vias; $('#cfImpAuto').checked = c.impressora.imprimirAoConfirmar; $('#cfImpEtiq').checked = c.impressora.etiquetasEmpresa !== false;
}
async function salvarConfig() {
  numeroPedidos = $('#cfNumero').value.trim();
  taxaPadrao = $('#cfTaxa').value === '' ? null : Number($('#cfTaxa').value);
  await api('PUT', '/api/config', {
    aceitandoPedidos: $('#cfAceitando').checked, taxaEntrega: $('#cfTaxa').value === '' ? null : Number($('#cfTaxa').value), chavePix: $('#cfPix').value.trim(), numeroPedidos: $('#cfNumero').value.trim(),
    disparo: { automatico: $('#cfDispAuto').checked, pelaApiOficial: $('#cfDispApi').checked, horario: $('#cfDispHora').value || '09:00' },
    whatsapp: { modo: $('#cfWModo').value, apiKey360: $('#cfW360').value.trim(), chaveWebhook: $('#cfWChave').value.trim(), urlPublica: $('#cfWUrl').value.trim().replace(/\/+$/, ''), phoneNumberId: $('#cfWPhone').value.trim(), token: $('#cfWToken').value.trim(), appSecret: $('#cfWSecret').value.trim(), verifyToken: $('#cfWVerify').value.trim(), templateCardapio: { nome: $('#cfWModelo').value.trim() || 'cardapio_do_dia', idioma: 'pt_BR' } },
    impressora: { modo: $('#cfImpModo').value, host: $('#cfImpHost').value.trim(), compartilhamento: $('#cfImpComp').value.trim(), colunas: Number($('#cfImpCols').value), vias: Number($('#cfImpVias').value) || 1, imprimirAoConfirmar: $('#cfImpAuto').checked, etiquetasEmpresa: $('#cfImpEtiq').checked },
  });
}
$('#cfSalvar').onclick = async () => { await salvarConfig(); toast('Configurações salvas'); };
$('#cfImpTeste').onclick = async () => {
  await salvarConfig();
  try { await api('POST', '/api/impressora/teste'); toast('Teste enviado para a impressora'); } catch (e) { toast('Erro: ' + e.message); }
};

function mostrarCamposWhats() {
  $('#cf360').hidden = $('#cfWModo').value !== 'dialog360';
  $('#cfMeta').hidden = $('#cfWModo').value !== 'meta';
  $('#cfWTeste').hidden = $('#cfWModo').value !== 'meta';
}
$('#cfWModo').onchange = mostrarCamposWhats;
$('#cfWCodigoBtn').onclick = async () => {
  try {
    await api('POST', '/api/whatsapp/codigo', { codigo: $('#cfWCodigo').value });
    $('#cfWCodigo').value = '';
    toast('WhatsApp conectado. Agora ative o recebimento na ferramenta de conexão.');
    carregarConfig();
  } catch (e) { toast('Erro: ' + e.message); }
};
$('#cfW360Reg').onclick = async () => {
  await salvarConfig();
  const base = $('#cfWUrl').value.trim().replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) return toast('Preencha o endereço público (https://...)');
  const chave = $('#cfWChave').value.trim();
  try { await api('POST', '/api/whatsapp/webhook360', { url: `${base}/webhook${chave ? '?chave=' + encodeURIComponent(chave) : ''}` }); toast('Webhook cadastrado no 360dialog'); } catch (e) { toast('Erro: ' + e.message); }
};
$('#cfWTeste').onclick = async () => {
  await salvarConfig();
  try { const r = await api('POST', '/api/whatsapp/teste'); toast(`Conectado: ${r.nome} ${r.numero}`); } catch (e) { toast('Erro: ' + e.message); }
};

// ---------- Atualização automática
async function ciclo() {
  try { await Promise.all([atualizarPedidos(), atualizarConversas()]); } catch {}
  // Caixa aberto na tela: acompanha os pedidos que vão chegando (sem atrapalhar quem está digitando).
  if (abaAtual === 'caixa' && !editando('#aba-caixa input, #aba-caixa select') && !document.querySelector('dialog[open]')) carregarCaixa().catch(() => {});
}
ciclo();
setInterval(ciclo, 3000);
