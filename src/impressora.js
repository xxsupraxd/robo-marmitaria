// Impressão do pedido na impressora térmica da cozinha (comandos ESC/POS).
// Modos (config.impressora.modo):
//   rede           -> impressora com cabo de rede/Wi-Fi, envia direto para IP:9100 (o mais comum e confiável)
//   compartilhada  -> Windows: impressora USB compartilhada, grava em \\localhost\NOME_DO_COMPARTILHAMENTO
//   arquivo        -> não imprime; salva o cupom em data/impressoes (para testar sem impressora)
//   desligada      -> não faz nada
const fs = require('fs');
const net = require('net');
const path = require('path');
const config = require('./config');
const { DATA_DIR } = require('./db');
const { reais, semAcentos, formatarTelefone } = require('./util');

const ESC = 0x1b;
const GS = 0x1d;

// Monta o cupom como uma lista de linhas com estilo; daí sai tanto o ESC/POS quanto a prévia em texto.
function montarCupom(pedido) {
  const L = [];
  const add = (texto, estilo = {}) => L.push({ texto: String(texto), ...estilo });
  const cfg = config.get();
  const hora = new Date(pedido.criadoEm).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

  add(`PEDIDO #${pedido.numero}`, { grande: true, centro: true });
  add(`${pedido.origem === 'balcao' ? 'BALCAO' : 'WHATSAPP'} - ${hora}`, { centro: true });
  add('-', { linha: true });
  if (pedido.agendadoPara) add(`ENTREGAR AS ${pedido.agendadoPara}`, { grande: true, centro: true });
  if (pedido.empresa) add(`EMPRESA: ${pedido.empresa}`, { grande: true });
  if (pedido.cliente.nome || !pedido.empresa) add(pedido.cliente.nome || 'Cliente', { grande: true });
  if (pedido.cliente.telefone) add(formatarTelefone(pedido.cliente.telefone));
  add('-', { linha: true });

  // Pedido com nome de funcionário (empresa): primeiro o total por tipo, para a cozinha montar de uma vez.
  const porFuncionario = pedido.itens.some((it) => it.funcionario);
  if (porFuncionario) {
    add('RESUMO', { negrito: true });
    for (const [desc, qtd] of resumoPorTipo(pedido.itens)) add(`${qtd}x ${desc}`, { negrito: true });
    add('-', { linha: true });
  }

  for (const it of pedido.itens) {
    add(`${it.quantidade}x ${it.nome} ${it.tamanho}`, { negrito: true, grande: true });
    if (it.funcionario) add(`   NOME: ${it.funcionario.toUpperCase()}`, { negrito: true });
    for (const [k, v] of Object.entries(it.opcoes || {})) add(`   ${k}: ${v}`, { negrito: true });
    for (const a of it.adicionais || []) add(`   + ${a.nome}`, { negrito: true });
    if (it.obs) add(`   >> ${it.obs.toUpperCase()}`, { negrito: true, grande: true });
    add('');
  }

  if (pedido.obs) {
    add(`OBS: ${pedido.obs.toUpperCase()}`, { negrito: true, grande: true });
    add('');
  }

  add('-', { linha: true });
  if (pedido.entrega?.tipo === 'entrega') {
    add('ENTREGA', { negrito: true, grande: true });
    add(pedido.entrega.endereco || '(sem endereço)');
  } else if (pedido.entrega?.tipo === 'retirada') {
    add('RETIRADA NO LOCAL', { negrito: true, grande: true });
  } else {
    add('CONSUMO/RETIRADA BALCAO', { negrito: true });
  }
  if (pedido.pagamento?.forma === 'Anotado') {
    add('ANOTADO NA CONTA (PAGAR DEPOIS)', { negrito: true });
  } else if (pedido.pagamento?.forma) {
    let pg = `Pagamento: ${pedido.pagamento.forma}`;
    if (pedido.pagamento.troco) pg += ` (troco p/ ${reais(pedido.pagamento.troco)})`;
    add(pg);
  }
  add(`TOTAL: ${reais(pedido.total)}${pedido.entrega?.tipo === 'entrega' && pedido.entrega.taxa == null ? ' + entrega' : ''}`, { negrito: true });
  add('-', { linha: true });
  add(cfg.nomeLoja, { centro: true });
  return L;
}

// "Marmita Tradicional M (Preto)" -> quantidade total, na ordem em que aparecem.
function resumoPorTipo(itens) {
  const mapa = new Map();
  for (const it of itens) {
    const extras = [...Object.values(it.opcoes || {}), ...(it.adicionais || []).map((a) => '+' + a.nome)];
    const desc = `${it.nome} ${it.tamanho}${extras.length ? ` (${extras.join(', ')})` : ''}`;
    mapa.set(desc, (mapa.get(desc) || 0) + (Number(it.quantidade) || 1));
  }
  return [...mapa];
}

// Uma etiqueta por marmita (pedido de empresa): vai colada na tampa, com o nome de quem vai comer.
const MAX_ETIQUETAS = 300;

function montarEtiquetas(pedido) {
  if (config.get().impressora.etiquetasEmpresa === false) return [];
  const folhas = [];
  const comNome = pedido.itens.filter((it) => it.funcionario);
  if (!comNome.length) return [];
  const total = comNome.reduce((s, it) => s + (Number(it.quantidade) || 1), 0);
  let n = 0;
  for (const it of comNome) {
    for (let i = 0; i < (Number(it.quantidade) || 1) && n < MAX_ETIQUETAS; i++) {
      n++;
      const L = [];
      const add = (texto, estilo = {}) => L.push({ texto: String(texto), ...estilo });
      add(`#${pedido.numero}  ${pedido.empresa || pedido.cliente.nome || ''}`.trim(), { centro: true, negrito: true });
      add(it.funcionario, { grande: true, centro: true });
      add(`${it.nome} ${it.tamanho}`, { negrito: true, centro: true });
      const extras = [...Object.entries(it.opcoes || {}).map(([k, v]) => `${k}: ${v}`), ...(it.adicionais || []).map((a) => '+ ' + a.nome)];
      if (extras.length) add(extras.join('  '), { centro: true });
      if (it.obs) add(`>> ${it.obs.toUpperCase()}`, { grande: true, centro: true });
      add(`${n}/${Math.min(total, MAX_ETIQUETAS)}${pedido.agendadoPara ? `  -  entregar as ${pedido.agendadoPara}` : ''}`, { centro: true });
      folhas.push(L);
    }
  }
  return folhas;
}

// Cupom da cozinha + etiquetas; cada folha é cortada separada.
function montarFolhas(pedido) {
  return [montarCupom(pedido), ...montarEtiquetas(pedido)];
}

function quebrar(texto, largura) {
  const out = [];
  for (const par of texto.split('\n')) {
    const recuo = par.match(/^ */)[0];
    let linha = recuo;
    for (const palavra of par.split(' ')) {
      if (!palavra) continue;
      if ((linha.trim() ? linha + ' ' + palavra : linha + palavra).length > largura) {
        if (linha) out.push(linha);
        linha = recuo + palavra;
        while (linha.length > largura) {
          out.push(linha.slice(0, largura));
          linha = linha.slice(largura);
        }
      } else {
        linha = linha.trim() ? linha + ' ' + palavra : linha + palavra;
      }
    }
    out.push(linha);
  }
  return out;
}

// Linha com estilo "fixo" (colunas alinhadas com espaços, ex.: fechamento de caixa) não é quebrada.
function linhasDe(l, largura) {
  return l.fixo ? [l.texto.replace(/\u2026/g, '...').slice(0, largura)] : quebrar(l.texto, largura);
}

function textoFolhas(folhas) {
  const cols = config.get().impressora.colunas || 48;
  const out = [];
  folhas.forEach((folha, i) => {
    if (i > 0) out.push('', '- - - - - - - - - - - (corte) - - - - - - - - - -'.slice(0, cols), '');
    for (const l of folha) {
      if (l.linha) { out.push('-'.repeat(cols)); continue; }
      const largura = l.grande ? Math.floor(cols / 2) : cols;
      for (const t of linhasDe(l, largura)) {
        const txt = l.grande ? t.toUpperCase() : t;
        out.push(l.centro ? txt.padStart(Math.floor((cols + txt.length) / 2)) : txt);
      }
    }
  });
  return out.join('\n');
}

function previaTexto(pedido) {
  return textoFolhas(montarFolhas(pedido));
}

// Deixa o texto seguro para a impressora: aspas curvas e travessões viram os simples, e qualquer
// caractere fora do Latin-1 (emoji etc.) ou de controle é removido. Sem isso, um “ copiado do celular
// vira o byte 0x1C, que a impressora entende como comando e pode engolir letras da observação.
function paraImpressora(s, tirarAcentos) {
  let t = String(s)
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\u2007\u202F]/g, ' ');
  if (tirarAcentos) t = semAcentos(t);
  return t.replace(/[^\n\x20-\x7E\xA0-\xFF]/gu, '');
}

function folhaEscPos(linhas, cfg, avanco = '\n\n\n\n') {
  const cols = cfg.colunas || 48;
  const partes = [Buffer.from([ESC, 0x40])]; // inicializa
  const codificar = (s) => Buffer.from(paraImpressora(s, cfg.semAcentos !== false), 'latin1');
  for (const l of linhas) {
    if (l.linha) { partes.push(codificar('-'.repeat(cols) + '\n')); continue; }
    partes.push(Buffer.from([ESC, 0x61, l.centro ? 1 : 0]));      // alinhamento
    partes.push(Buffer.from([ESC, 0x45, l.negrito || l.grande ? 1 : 0])); // negrito
    partes.push(Buffer.from([GS, 0x21, l.grande ? 0x11 : 0x00]));  // tamanho dobrado
    const largura = l.grande ? Math.floor(cols / 2) : cols;
    for (const t of linhasDe(l, largura)) partes.push(codificar(t + '\n'));
  }
  partes.push(Buffer.from([GS, 0x21, 0, ESC, 0x45, 0, ESC, 0x61, 0]));
  partes.push(Buffer.from(avanco));
  partes.push(Buffer.from([GS, 0x56, 0x42, 0x00])); // corte parcial
  return Buffer.concat(partes);
}

function gerarEscPos(pedido, o = { cupom: true, etiquetas: true }) {
  const cfg = config.get().impressora;
  const partes = [];
  // As vias valem para o cupom; as etiquetas saem uma vez só.
  if (o.cupom !== false) partes.push(...Array(Math.max(1, cfg.vias || 1)).fill(folhaEscPos(montarCupom(pedido), cfg)));
  if (o.etiquetas !== false) partes.push(...montarEtiquetas(pedido).map((f) => folhaEscPos(f, cfg, '\n\n\n')));
  return Buffer.concat(partes);
}

function folhasDoPedido(pedido, o) {
  return [...(o.cupom !== false ? [montarCupom(pedido)] : []), ...(o.etiquetas !== false ? montarEtiquetas(pedido) : [])];
}

function enviarRede(buf, host, porta) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port: porta || 9100 });
    sock.setTimeout(5000);
    sock.on('connect', () => sock.end(buf));
    sock.on('close', (erro) => (erro ? null : resolve()));
    sock.on('timeout', () => { sock.destroy(); reject(new Error(`Impressora ${host} não respondeu`)); });
    sock.on('error', (e) => reject(new Error(`Falha ao conectar na impressora ${host}: ${e.message}`)));
  });
}

// Manda os bytes para a impressora conforme o modo; no modo arquivo salva o .bin e a prévia .txt.
async function enviar(buf, nomeArquivo, folhas) {
  const cfg = config.get().impressora;
  if (cfg.modo === 'desligada') return { ok: true, modo: 'desligada' };
  if (!buf.length) return { ok: true, modo: cfg.modo, vazio: true };
  if (cfg.modo === 'rede') {
    await enviarRede(buf, cfg.host, cfg.porta);
  } else if (cfg.modo === 'compartilhada') {
    fs.writeFileSync(cfg.compartilhamento, buf);
  } else {
    const dir = path.join(DATA_DIR, 'impressoes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${nomeArquivo}.txt`), textoFolhas(folhas) + '\n');
    fs.writeFileSync(path.join(dir, `${nomeArquivo}.bin`), buf);
  }
  return { ok: true, modo: cfg.modo };
}

async function imprimir(pedido, o = { cupom: true, etiquetas: true }) {
  const sufixo = o.cupom === false ? '-etiquetas' : o.etiquetas === false ? '-cupom' : '';
  return enviar(gerarEscPos(pedido, o), `pedido-${pedido.numero}${sufixo}`, folhasDoPedido(pedido, o));
}

// Qualquer outro papel (ex.: fechamento de caixa). folhas = lista de folhas, cada uma uma lista de linhas.
async function imprimirFolhas(folhas, nomeArquivo) {
  const cfg = config.get().impressora;
  return enviar(Buffer.concat(folhas.map((f) => folhaEscPos(f, cfg))), nomeArquivo, folhas);
}

module.exports = { imprimir, imprimirFolhas, previaTexto, textoFolhas, gerarEscPos, montarEtiquetas, resumoPorTipo, paraImpressora, MAX_ETIQUETAS };
