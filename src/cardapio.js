const { load, save } = require('./db');
const { hoje, diaSemana, dataPorExtenso, reais } = require('./util');
const config = require('./config');

const ADICIONAIS_PADRAO = [
  { nome: 'Ovo', preco: 3 },
  { nome: 'Bife', preco: 10 },
  { nome: 'Filé de peito', preco: 8 },
];

const TRADICIONAL = {
  id: 'tradicional',
  nome: 'Marmita Tradicional',
  descricao: 'Arroz, feijão, costela de panela, macarrão ao molho vermelho, farofa, couve refogada e salada de alface',
  tamanhos: { P: 17, M: 20, G: 23 },
  opcoes: [{ nome: 'Feijão', valores: ['Preto', 'Branco'] }],
  aceitaAdicionais: true,
};

const MODELOS = {
  'dia-comum': {
    nomeModelo: 'Dia comum',
    acompanhamentos: '',
    itens: [TRADICIONAL],
    adicionais: ADICIONAIS_PADRAO,
    aviso: 'Devido à alta demanda, o cardápio pode sofrer alterações.',
  },
  sabado: {
    nomeModelo: 'Sábado (feijoada)',
    acompanhamentos: '',
    itens: [
      TRADICIONAL,
      {
        id: 'feijoada',
        nome: 'Feijoada individual',
        descricao: 'Feijoada com acompanhamentos, na mesma embalagem',
        tamanhos: { P: 20, M: 30, G: 40 },
        opcoes: [],
        aceitaAdicionais: false,
      },
      {
        id: 'kit-feijoada',
        nome: 'Kit Feijoada',
        descricao: 'Marmita de feijoada + marmita com arroz, farofa, couve e torresmo',
        tamanhos: { M: 45, G: 55 },
        opcoes: [],
        aceitaAdicionais: false,
      },
    ],
    adicionais: ADICIONAIS_PADRAO,
    aviso: 'Devido à alta demanda, o cardápio pode sofrer alterações.',
  },
};

function obter(data = hoje()) {
  return load().cardapios[data] || null;
}

function salvar(data, cardapio) {
  const db = load();
  // Cada marmita precisa de um id único e simples (vai em ids de campos do painel e no carrinho do robô).
  const usados = new Set();
  const idUnico = (bruto) => {
    let id = String(bruto || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!id || usados.has(id)) {
      let n = 1;
      while (usados.has('item' + n)) n++;
      id = 'item' + n;
    }
    usados.add(id);
    return id;
  };
  const itens = (cardapio.itens || [])
    .filter((i) => i && i.nome && Object.keys(i.tamanhos || {}).length)
    .map((i) => ({
      id: idUnico(i.id),
      nome: String(i.nome).trim(),
      descricao: String(i.descricao || '').trim(),
      tamanhos: Object.fromEntries(
        Object.entries(i.tamanhos).filter(([, p]) => p !== '' && p != null && !isNaN(p)).map(([t, p]) => [t, Number(p)])
      ),
      opcoes: (i.opcoes || []).filter((o) => o.nome && o.valores && o.valores.length),
      aceitaAdicionais: i.aceitaAdicionais !== false,
      esgotado: !!i.esgotado,
    }));
  db.cardapios[data] = {
    data,
    acompanhamentos: String(cardapio.acompanhamentos || '').trim(),
    itens,
    adicionais: (cardapio.adicionais || []).filter((a) => a.nome).map((a) => ({ nome: a.nome, preco: Number(a.preco) || 0 })),
    aviso: String(cardapio.aviso || '').trim(),
    atualizadoEm: new Date().toISOString(),
  };
  save();
  return db.cardapios[data];
}

// Sugestão de modelo para a data: sábado já vem com as feijoadas.
function modeloSugerido(data = hoje()) {
  return diaSemana(data) === 6 ? 'sabado' : 'dia-comum';
}

function itensDisponiveis(cardapio) {
  return (cardapio?.itens || []).filter((i) => !i.esgotado);
}

// Texto do cardápio no formato do WhatsApp (*negrito*, _itálico_).
function textoWhatsApp(cardapio) {
  const cfg = config.get();
  const linhas = [];
  linhas.push(`🍽️ *${cfg.nomeLoja}*`);
  linhas.push(`*Cardápio de ${dataPorExtenso(cardapio.data)}*`);
  linhas.push('');
  for (const item of itensDisponiveis(cardapio)) {
    linhas.push(`🍱 *${item.nome}*`);
    if (item.descricao) linhas.push(item.descricao);
    linhas.push(Object.entries(item.tamanhos).map(([t, p]) => `${t} ${reais(p)}`).join('  |  '));
    linhas.push('');
  }
  if (cardapio.acompanhamentos) {
    linhas.push(`🥗 ${cardapio.acompanhamentos}`);
    linhas.push('');
  }
  if (cardapio.adicionais?.length) {
    linhas.push('➕ *Adicionais:* ' + cardapio.adicionais.map((a) => `${a.nome} ${reais(a.preco)}`).join(', '));
    linhas.push('');
  }
  if (cardapio.aviso) linhas.push(`⚠️ _${cardapio.aviso}_`);
  return linhas.join('\n').trim();
}

module.exports = { MODELOS, obter, salvar, modeloSugerido, itensDisponiveis, textoWhatsApp };
