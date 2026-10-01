// Ponte entre o sistema e o WhatsApp.
// Modos (config.whatsapp.modo):
//   simulador -> nada sai de verdade; a conversa aparece no painel (aba Simulador)
//   meta      -> API oficial do WhatsApp direto na Meta (WhatsApp Cloud API)
//   dialog360 -> API oficial pelo parceiro 360dialog (necessário para a coexistência:
//                mesmo número no aplicativo do celular e no robô)
// As mensagens que chegam da Meta entram pelo webhook em server.js e vão para robo.receber().
const crypto = require('crypto');
const config = require('./config');

// Segredos podem ficar no config.json ou em variáveis de ambiente (que têm prioridade).
function cfgMeta() {
  const w = config.get().whatsapp || {};
  return {
    urlApi: w.urlApi || 'https://graph.facebook.com',
    versaoApi: w.versaoApi || 'v25.0',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || w.phoneNumberId,
    token: process.env.WHATSAPP_TOKEN || w.token,
    appSecret: process.env.WHATSAPP_APP_SECRET || w.appSecret,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || w.verifyToken,
    template: { nome: 'cardapio_do_dia', idioma: 'pt_BR', ...(w.templateCardapio || {}) },
    url360: w.url360 || 'https://waba-v2.360dialog.io',
    apiKey360: process.env.WHATSAPP_360_API_KEY || w.apiKey360,
    chaveWebhook: process.env.WHATSAPP_CHAVE_WEBHOOK || w.chaveWebhook,
  };
}

// O formato da mensagem é o mesmo nos dois; muda só o endereço e a autenticação.
async function chamarApi(corpo) {
  const m = cfgMeta();
  let url, headers;
  if (modo() === 'dialog360') {
    if (!m.apiKey360) throw new Error('360dialog sem API key configurada');
    url = `${m.url360}/messages`;
    headers = { 'D360-API-KEY': m.apiKey360 };
  } else {
    if (!m.phoneNumberId || !m.token) throw new Error('WhatsApp oficial sem Phone Number ID ou token configurado');
    url = `${m.urlApi}/${m.versaoApi}/${m.phoneNumberId}/messages`;
    headers = { Authorization: `Bearer ${m.token}` };
  }
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...corpo }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || d.meta?.developer_message || `API respondeu ${r.status}`);
  return d;
}

// Cadastra no 360dialog o endereço que recebe as mensagens (lá não se configura pelo site da Meta).
async function registrarWebhook360(url) {
  const m = cfgMeta();
  if (!m.apiKey360) throw new Error('Preencha a API key do 360dialog');
  const r = await fetch(`${m.url360}/v1/configs/webhook`, {
    method: 'POST',
    headers: { 'D360-API-KEY': m.apiKey360, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.meta?.developer_message || d.error?.message || `360dialog respondeu ${r.status}`);
  return d;
}

const adaptadores = {
  simulador: {
    async enviar() {},
    async enviarModelo() {},
  },
  meta: {
    async enviar(telefone, texto) {
      return chamarApi({ to: telefone, type: 'text', text: { body: texto, preview_url: false } });
    },
    // Mensagens fora da janela de 24h (como o cardápio da manhã) só podem ser modelos aprovados pela Meta.
    async enviarModelo(telefone, parametros) {
      const { template } = cfgMeta();
      return chamarApi({
        to: telefone,
        type: 'template',
        template: {
          name: template.nome,
          language: { code: template.idioma },
          components: [{ type: 'body', parameters: parametros.map((text) => ({ type: 'text', text: limparParametro(text) })) }],
        },
      });
    },
  },
};
adaptadores.dialog360 = adaptadores.meta; // mesmo formato, chamarApi escolhe o endereço

// A Meta não aceita quebra de linha, tab ou mais de 4 espaços seguidos dentro de um parâmetro de modelo.
function limparParametro(s) {
  return String(s).replace(/[\r\n\t]+/g, ' | ').replace(/ {4,}/g, '   ').slice(0, 1000);
}

function modo() {
  return config.get().whatsapp?.modo || 'simulador';
}

function adaptador() {
  const ad = adaptadores[modo()];
  if (!ad) throw new Error(`Integração de WhatsApp "${modo()}" não existe`);
  return ad;
}

const enviar = (telefone, texto) => adaptador().enviar(telefone, texto);
const enviarModelo = (telefone, parametros) => adaptador().enviarModelo(telefone, parametros);

// ---- Webhook da Meta

// GET de verificação feito pela Meta ao cadastrar o webhook.
function verificarWebhook(q) {
  const { verifyToken } = cfgMeta();
  if (q.get('hub.mode') === 'subscribe' && verifyToken && q.get('hub.verify_token') === verifyToken) return q.get('hub.challenge');
  return null;
}

// Confere a assinatura X-Hub-Signature-256 (garante que a mensagem veio mesmo da Meta).
// No 360dialog não há assinatura: a proteção é uma chave secreta no próprio endereço (?chave=...).
function chaveValida(q) {
  const { chaveWebhook } = cfgMeta();
  return !chaveWebhook || q.get('chave') === chaveWebhook;
}

function assinaturaValida(corpoBruto, cabecalho) {
  const { appSecret } = cfgMeta();
  if (!appSecret || modo() === 'dialog360') return true; // sem App Secret configurado, não dá para conferir
  const esperado = 'sha256=' + crypto.createHmac('sha256', appSecret).update(corpoBruto).digest('hex');
  const a = Buffer.from(esperado);
  const b = Buffer.from(String(cabecalho || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Extrai as mensagens de texto (ou cliques em botões) do corpo do webhook.
function extrairMensagens(corpo) {
  const out = [];
  for (const entry of corpo?.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      const nomes = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name || '']));
      for (const m of v.messages || []) {
        let texto = null;
        if (m.type === 'text') texto = m.text?.body;
        else if (m.type === 'button') texto = m.button?.text;
        else if (m.type === 'interactive') texto = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title;
        out.push({ id: m.id, telefone: m.from, nome: nomes[m.from] || '', texto, tipo: m.type });
      }
      // Coexistência: mensagens que alguém mandou pelo aplicativo do celular chegam como "eco".
      for (const m of v.message_echoes || []) {
        out.push({ id: m.id, telefone: m.to, eco: true, texto: m.type === 'text' ? m.text?.body : `[${m.type}]`, tipo: m.type });
      }
    }
  }
  return out;
}

module.exports = { enviar, enviarModelo, modo, adaptadores, verificarWebhook, assinaturaValida, chaveValida, extrairMensagens, limparParametro, registrarWebhook360 };
