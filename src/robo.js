// O robô de atendimento: conversa por números (1, 2, 3...), funciona em qualquer integração de WhatsApp.
const conversas = require('./conversas');
const contatos = require('./contatos');
const cardapio = require('./cardapio');
const pedidos = require('./pedidos');
const contas = require('./contas');
const config = require('./config');
const { save } = require('./db');
const { reais } = require('./util');

const INATIVIDADE_MS = 2 * 60 * 60 * 1000; // depois de 2h parado, a conversa recomeça do início
const PALAVRAS_MENU = ['menu', 'inicio', 'início', 'voltar ao inicio', 'recomeçar', 'recomecar'];

const norm = (s) => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const num = (s) => {
  const m = String(s).trim().match(/^\d+$/);
  return m ? parseInt(m[0], 10) : null;
};

function menuPrincipal(nome) {
  const cfg = config.get();
  const ola = nome ? `Olá, ${nome.split(' ')[0]}! 😊` : 'Olá! 😊';
  return `${ola} Bem-vindo(a) à *${cfg.nomeLoja}*.\n\nDigite o número da opção:\n*1* - Fazer pedido\n*2* - Ver cardápio de hoje\n*3* - Falar com atendente`;
}

function listaItens(cd, carrinhoVazio) {
  const itens = cardapio.itensDisponiveis(cd);
  const linhas = itens.map((it, i) => {
    const precos = Object.entries(it.tamanhos).map(([t, p]) => `${t} ${reais(p)}`).join(' | ');
    return `*${i + 1}* - ${it.nome}\n     ${precos}`;
  });
  return `Qual marmita você quer?\n\n${linhas.join('\n')}\n\n*0* - ${carrinhoVazio ? 'Voltar' : 'Ver meu pedido'}`;
}

function textoCarrinho(carrinho) {
  return pedidos.resumoTexto({ itens: carrinho.map(pedidos.calcularItem) });
}

function totalCarrinho(carrinho) {
  return carrinho.map(pedidos.calcularItem).reduce((s, i) => s + i.total, 0);
}

function reset(c) {
  c.estado = 'menu';
  c.rascunho = null;
  c.carrinho = [];
  c.pedidoParcial = {};
}

async function responder(c, texto) {
  await conversas.enviar(c.telefone, texto, 'robo');
}

// Ponto de entrada: toda mensagem que chega do cliente passa aqui.
async function receber(telefone, nome, texto) {
  const c = conversas.obter(telefone, nome);
  const parado = Date.now() - new Date(c.atualizadoEm).getTime() > INATIVIDADE_MS;
  conversas.registrar(telefone, 'cliente', texto);
  contatos.salvar(telefone, contatos.obter(telefone) ? {} : { nome });

  let t = norm(texto);
  // Botões de resposta rápida do modelo do cardápio.
  if (t === 'fazer pedido') t = texto = '1';
  if (t === 'nao receber mais') t = 'sair';

  // Áudio, foto, documento...: o robô não entende, mas o atendente vê no painel.
  if (/^\[\w+\]$/.test(t)) {
    if (c.roboPausado) return;
    return responder(c, t === '[image]' || t === '[document]'
      ? 'Recebemos seu arquivo, obrigado! 👍 Se for o comprovante do Pix, já vamos conferir.'
      : 'Ainda não consigo ouvir áudios 😅 Responda com o número da opção, ou digite *atendente* para falar com a gente.');
  }

  if (t === 'sair' || t === 'parar') {
    contatos.salvar(telefone, { recebeCardapio: false });
    return responder(c, 'Pronto, você não vai mais receber o cardápio diário. Para voltar a receber, é só mandar *CARDAPIO*.');
  }
  if (t === 'cardapio' && contatos.obter(telefone)?.recebeCardapio === false) {
    contatos.salvar(telefone, { recebeCardapio: true });
  }

  // Atendente assumiu a conversa: o robô fica quieto até alguém devolver no painel,
  // ou até passar 2h sem o atendente escrever (aí o robô volta sozinho).
  if (c.roboPausado && c.pausadoEm && Date.now() - new Date(c.pausadoEm).getTime() > INATIVIDADE_MS) {
    c.roboPausado = false;
    c.estado = 'inicio';
  }
  if (c.roboPausado) return;
  if (c.estado === 'inicio') {
    reset(c);
    save();
    return responder(c, menuPrincipal(c.nome));
  }

  if (t === 'atendente' || t === 'humano') return chamarAtendente(c);
  if (t === 'cancelar') {
    reset(c);
    save();
    return responder(c, 'Pedido cancelado. ' + menuPrincipal(c.nome).split('\n\n').slice(1).join('\n\n'));
  }
  if (c.estado === 'inicio' || parado || PALAVRAS_MENU.includes(t)) {
    reset(c);
    save();
    return responder(c, menuPrincipal(c.nome));
  }

  try {
    await passo(c, texto, t);
  } finally {
    save();
  }
}

async function chamarAtendente(c) {
  c.roboPausado = true;
  c.pausadoEm = new Date().toISOString();
  save();
  await responder(c, 'Certo! Um atendente vai continuar a conversa com você em instantes. 🙋');
}

async function passo(c, textoOriginal, t) {
  const cd = cardapio.obter();
  const cfg = config.get();
  const r = c.rascunho;
  const n = num(t);

  switch (c.estado) {
    case 'menu': {
      if (n === 1) return iniciarPedido(c, cd, cfg);
      if (n === 2) {
        if (!cd) return responder(c, 'O cardápio de hoje ainda não foi publicado. Tente daqui a pouco ou digite *3* para falar com um atendente.');
        return responder(c, cardapio.textoWhatsApp(cd) + '\n\nDigite *1* para fazer seu pedido.');
      }
      if (n === 3) return chamarAtendente(c);
      return responder(c, 'Não entendi. 🤔\n\n' + menuPrincipal(c.nome));
    }

    case 'item': {
      const itens = cardapio.itensDisponiveis(cd);
      if (n === 0) {
        if (!c.carrinho.length) { reset(c); return responder(c, menuPrincipal(c.nome)); }
        return perguntarMais(c);
      }
      const item = itens[n - 1];
      if (!item) return responder(c, 'Opção inválida. ' + listaItens(cd, !c.carrinho.length));
      c.rascunho = { itemId: item.id, nome: item.nome, opcoes: {}, adicionais: [] };
      return perguntarTamanho(c, item);
    }

    case 'tamanho': {
      const item = achar(cd, r);
      const tams = Object.keys(item.tamanhos);
      const tam = tams[n - 1] || tams.find((x) => norm(x) === t);
      if (!tam) return perguntarTamanho(c, item, 'Opção inválida. ');
      r.tamanho = tam;
      r.preco = item.tamanhos[tam];
      r.opcaoIdx = 0;
      return proximaOpcao(c, item);
    }

    case 'opcao': {
      const item = achar(cd, r);
      const op = item.opcoes[r.opcaoIdx];
      const v = op.valores[n - 1] || op.valores.find((x) => norm(x) === t);
      if (!v) return perguntarOpcao(c, op, 'Opção inválida. ');
      r.opcoes[op.nome] = v;
      r.opcaoIdx++;
      return proximaOpcao(c, item);
    }

    case 'adicionais': {
      const escolhas = t.split(/[\s,;e]+/).map(num).filter((x) => x !== null);
      if (!escolhas.length) return perguntarAdicionais(c, cd, 'Opção inválida. ');
      if (!escolhas.includes(0)) {
        const invalida = escolhas.find((x) => !cd.adicionais[x - 1]);
        if (invalida) return perguntarAdicionais(c, cd, `Não existe a opção ${invalida}. `);
        r.adicionais = escolhas.map((x) => cd.adicionais[x - 1]);
      }
      c.estado = 'quantidade';
      return responder(c, 'Quantas marmitas iguais a essa? (digite o número, ex.: *1*)');
    }

    case 'quantidade': {
      if (!n || n < 1 || n > 50) return responder(c, 'Digite a quantidade em números, ex.: *1* ou *2*.');
      r.quantidade = n;
      c.estado = 'obs';
      return responder(c, 'Alguma observação para essa marmita? (ex.: *sem abobrinha*, *pouco arroz*)\n\nSe não tiver, digite *0*.');
    }

    case 'obs': {
      if (t !== '0' && t !== 'nao' && t !== 'não') r.obs = textoOriginal.trim().slice(0, 200);
      c.carrinho.push({ itemId: r.itemId, nome: r.nome, tamanho: r.tamanho, preco: r.preco, opcoes: r.opcoes, adicionais: r.adicionais, quantidade: r.quantidade, obs: r.obs || '' });
      c.rascunho = null;
      return perguntarMais(c);
    }

    case 'mais': {
      if (n === 1) { c.estado = 'item'; return responder(c, listaItens(cd, false)); }
      if (n === 2) return perguntarNome(c);
      if (n === 3) {
        c.carrinho.pop();
        if (!c.carrinho.length) { c.estado = 'item'; return responder(c, 'Item removido.\n\n' + listaItens(cd, true)); }
        return perguntarMais(c, 'Último item removido.\n\n');
      }
      return perguntarMais(c, 'Opção inválida.\n\n');
    }

    case 'nome': {
      const nomeSalvo = c.pedidoParcial.nomeSugerido;
      if (n === 1 && nomeSalvo) c.pedidoParcial.nome = nomeSalvo;
      else if (textoOriginal.trim().length >= 2 && n === null) c.pedidoParcial.nome = textoOriginal.trim().slice(0, 60);
      else return responder(c, 'Digite o nome para o pedido.');
      contatos.salvar(c.telefone, { nome: c.pedidoParcial.nome });
      c.estado = 'entrega';
      return responder(c, 'Vai retirar ou é para entregar?\n\n*1* - Retirar no local\n*2* - Entrega' + (cfg.mensagemTaxaEntrega ? ` (${cfg.mensagemTaxaEntrega})` : ''));
    }

    case 'entrega': {
      if (n === 1) { c.pedidoParcial.entrega = { tipo: 'retirada' }; return perguntarPagamento(c); }
      if (n === 2) {
        c.pedidoParcial.entrega = { tipo: 'entrega' };
        c.estado = 'endereco';
        const end = contatos.obter(c.telefone)?.endereco;
        if (end) return responder(c, `Entregar no mesmo endereço?\n📍 ${end}\n\n*1* - Sim\nOu digite o novo endereço (rua, número, bairro e referência).`);
        return responder(c, 'Digite o endereço de entrega (rua, número, bairro e ponto de referência).');
      }
      return responder(c, 'Digite *1* para retirar ou *2* para entrega.');
    }

    case 'endereco': {
      const end = contatos.obter(c.telefone)?.endereco;
      if (n === 1 && end) c.pedidoParcial.entrega.endereco = end;
      else if (textoOriginal.trim().length >= 8) c.pedidoParcial.entrega.endereco = textoOriginal.trim().slice(0, 250);
      else return responder(c, 'Endereço muito curto. Digite rua, número e bairro.');
      contatos.salvar(c.telefone, { endereco: c.pedidoParcial.entrega.endereco });
      return perguntarPagamento(c);
    }

    case 'pagamento': {
      const formas = { 1: 'Pix', 2: 'Dinheiro', 3: 'Cartão' };
      if (podeAnotar(c)) formas[4] = contas.ANOTADO;
      if (!formas[n]) return perguntarPagamento(c, 'Opção inválida. ');
      c.pedidoParcial.pagamento = { forma: formas[n] };
      if (n === 2) { c.estado = 'troco'; return responder(c, 'Precisa de troco para quanto? (ex.: *50*)\nSe não precisar, digite *0*.'); }
      return confirmar(c);
    }

    case 'troco': {
      const v = parseFloat(t.replace(/[^\d,.]/g, '').replace(',', '.'));
      if (isNaN(v)) return responder(c, 'Digite só o valor, ex.: *50*, ou *0* se não precisar de troco.');
      if (v > 0) c.pedidoParcial.pagamento.troco = v;
      return confirmar(c);
    }

    case 'confirmar': {
      if (n === 1) return finalizar(c);
      if (n === 2) { reset(c); return responder(c, 'Pedido cancelado. Quando quiser, é só chamar! 👋'); }
      return responder(c, 'Digite *1* para confirmar ou *2* para cancelar.');
    }

    default:
      reset(c);
      return responder(c, menuPrincipal(c.nome));
  }
}

function achar(cd, r) {
  return cd.itens.find((i) => i.id === r.itemId);
}

function iniciarPedido(c, cd, cfg) {
  if (!cfg.aceitandoPedidos) return responder(c, 'No momento não estamos aceitando pedidos pelo WhatsApp. 😕 Digite *3* para falar com um atendente.');
  if (!cd || !cardapio.itensDisponiveis(cd).length) return responder(c, 'O cardápio de hoje ainda não foi publicado. Tente daqui a pouco ou digite *3* para falar com um atendente.');
  c.estado = 'item';
  c.carrinho = [];
  c.pedidoParcial = {};
  return responder(c, listaItens(cd, true));
}

function perguntarTamanho(c, item, prefixo = '') {
  c.estado = 'tamanho';
  const tams = Object.entries(item.tamanhos).map(([t, p], i) => `*${i + 1}* - ${t} (${reais(p)})`);
  return responder(c, `${prefixo}*${item.nome}* — qual tamanho?\n\n${tams.join('\n')}`);
}

function perguntarOpcao(c, op, prefixo = '') {
  c.estado = 'opcao';
  return responder(c, `${prefixo}${op.nome}:\n\n${op.valores.map((v, i) => `*${i + 1}* - ${v}`).join('\n')}`);
}

function proximaOpcao(c, item) {
  const r = c.rascunho;
  if (r.opcaoIdx < item.opcoes.length) return perguntarOpcao(c, item.opcoes[r.opcaoIdx]);
  const cd = cardapio.obter();
  if (item.aceitaAdicionais && cd.adicionais?.length) return perguntarAdicionais(c, cd);
  c.estado = 'quantidade';
  return responder(c, 'Quantas marmitas iguais a essa? (digite o número, ex.: *1*)');
}

function perguntarAdicionais(c, cd, prefixo = '') {
  c.estado = 'adicionais';
  const l = cd.adicionais.map((a, i) => `*${i + 1}* - ${a.nome} (+${reais(a.preco)})`);
  return responder(c, `${prefixo}Quer algum adicional?\n\n${l.join('\n')}\n*0* - Nenhum\n\nPode escolher mais de um, ex.: *1,2*`);
}

function perguntarMais(c, prefixo = '') {
  c.estado = 'mais';
  return responder(c, `${prefixo}🧾 *Seu pedido até agora:*\n${textoCarrinho(c.carrinho)}\n\n*Subtotal: ${reais(totalCarrinho(c.carrinho))}*\n\n*1* - Adicionar outra marmita\n*2* - Finalizar pedido\n*3* - Remover o último item`);
}

function perguntarNome(c) {
  c.estado = 'nome';
  const salvo = contatos.obter(c.telefone)?.nome || c.nome;
  c.pedidoParcial.nomeSugerido = salvo || null;
  if (salvo) return responder(c, `O pedido fica em nome de *${salvo}*?\n\n*1* - Sim\nOu digite outro nome.`);
  return responder(c, 'Qual o nome para o pedido?');
}

// Só aparece para quem a loja liberou "anotar" na conta do cliente (aba Clientes).
const podeAnotar = (c) => !!contas.porTelefone(c.telefone)?.anotar;

function perguntarPagamento(c, prefixo = '') {
  c.estado = 'pagamento';
  return responder(c, `${prefixo}Forma de pagamento:\n\n*1* - Pix\n*2* - Dinheiro\n*3* - Cartão${podeAnotar(c) ? '\n*4* - Anotar na minha conta' : ''}`);
}

function confirmar(c) {
  c.estado = 'confirmar';
  const p = c.pedidoParcial;
  const cfg = config.get();
  let entrega = '🏠 Retirada no local';
  if (p.entrega.tipo === 'entrega') entrega = `🛵 Entrega: ${p.entrega.endereco}` + (cfg.taxaEntrega != null ? `\nTaxa de entrega: ${reais(cfg.taxaEntrega)}` : `\n_(${cfg.mensagemTaxaEntrega || 'taxa de entrega a confirmar'})_`);
  const total = totalCarrinho(c.carrinho) + (p.entrega.tipo === 'entrega' && cfg.taxaEntrega ? cfg.taxaEntrega : 0);
  const pg = p.pagamento.forma === contas.ANOTADO ? 'Anotar na sua conta' : p.pagamento.forma + (p.pagamento.troco ? ` (troco para ${reais(p.pagamento.troco)})` : '');
  return responder(
    c,
    `Confira seu pedido:\n\n👤 ${p.nome}\n${textoCarrinho(c.carrinho)}\n\n${entrega}\n💳 ${pg}\n\n*Total: ${reais(total)}*\n\n*1* - Confirmar pedido\n*2* - Cancelar`
  );
}

async function finalizar(c) {
  const p = c.pedidoParcial;
  let pedido;
  try {
    pedido = await pedidos.criar({
      origem: 'whatsapp',
      cliente: { nome: p.nome, telefone: c.telefone },
      itens: c.carrinho,
      entrega: p.entrega,
      pagamento: p.pagamento,
    });
  } catch (e) {
    // A loja tirou a liberação de anotar entre a escolha e a confirmação.
    if (p.pagamento?.forma === contas.ANOTADO && /liberado/.test(e.message)) return perguntarPagamento(c, 'Não foi possível anotar na sua conta. 😕 Escolha outra forma de pagamento.\n\n');
    throw e;
  }
  const cfg = config.get();
  reset(c);
  c.ultimoPedido = pedido.id;
  let msg = `✅ *Pedido #${pedido.numero} confirmado!* Já foi para a cozinha. Obrigado, ${p.nome.split(' ')[0]}!`;
  if (pedido.pagamento.forma === 'Pix' && cfg.chavePix) msg += `\n\nChave Pix: *${cfg.chavePix}*\nValor: ${reais(pedido.total)}${pedido.entrega.tipo === 'entrega' && pedido.entrega.taxa == null ? ' + taxa de entrega' : ''}\nMande o comprovante aqui, por favor.`;
  await responder(c, msg);
}

// Avisos automáticos quando o balcão muda o status do pedido.
async function avisarStatus(pedido) {
  if (pedido.origem !== 'whatsapp' || !pedido.cliente.telefone) return;
  const msgs = {
    pronto: pedido.entrega?.tipo === 'retirada' ? `Seu pedido #${pedido.numero} está pronto para retirada! 🍱` : null,
    saiu: `Seu pedido #${pedido.numero} saiu para entrega${pedido.entregador ? ` com ${pedido.entregador}` : ''}! 🛵`,
    cancelado: `Seu pedido #${pedido.numero} foi cancelado. Qualquer dúvida, é só responder aqui.`,
  };
  if (msgs[pedido.status]) await conversas.enviar(pedido.cliente.telefone, msgs[pedido.status], 'robo');
}

// Coexistência: alguém respondeu pelo aplicativo do celular. Mostra no painel e tira o robô da conversa.
function receberEco(telefone, texto) {
  const c = conversas.obter(telefone);
  conversas.registrar(telefone, 'atendente', texto || '', { celular: true });
  c.roboPausado = true;
  c.pausadoEm = new Date().toISOString();
  c.naoLidas = 0;
  save();
}

module.exports = { receber, receberEco, avisarStatus };
