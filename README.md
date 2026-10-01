# Robô de pedidos – Marmitaria Tempero da Família

Protótipo do sistema da marmitaria: robô de atendimento no WhatsApp, painel do balcão e impressão dos pedidos na cozinha.

## Como rodar no computador do balcão

1. Instale o **Node.js** (versão LTS) em https://nodejs.org
2. Copie esta pasta para o computador (ex.: `C:\robo-marmitaria`)
3. Dê dois cliques em **`iniciar.bat`** (ou rode `node server.js`)
4. O painel abre em **http://localhost:3000**

Não precisa instalar mais nada: o sistema não usa bibliotecas externas. Os dados ficam na pasta `data` (`db.json` e os pedidos em `data/pedidos`, um arquivo por mês). Para backup, copie a pasta `data` inteira.

## O que o painel faz

| Aba | Para quê |
|---|---|
| **Pedidos** | Quadro por etapa: Recebidos, Em preparo, Na entrega / pronto, Finalizados. Botões grandes para iniciar preparo, **dar saída** (com nome do entregador, avisa o cliente no WhatsApp) e marcar entregue. Bip a cada pedido novo, tempo de espera (destaca depois de 40 min), reimpressão |
| **Conversas** | Todas as conversas do WhatsApp. O atendente pode **assumir** uma conversa (o robô para de responder) e depois devolver |
| **+ Pedido balcão** | Lançar pedido feito pessoalmente ou por telefone, inclusive **pedido de empresa** com horário de entrega e o **nome e a observação de cada funcionário**; imprime na cozinha na hora |
| **Caixa** | Fechamento do dia: **vendido**, **recebido** (dinheiro, Pix, cartão), **anotado** (pagar depois) e o que ainda não foi finalizado. Troco inicial, retiradas, conferência do dinheiro da gaveta (sobrou/faltou), fechamento impresso na térmica e resumo do mês dia a dia |
| **Clientes** | Conta de cada cliente e de cada empresa: histórico de pedidos por mês, quanto está **em aberto**, receber pagamento, total **por funcionário** (empresa) e **extrato do mês** para imprimir, salvar em PDF ou copiar para o WhatsApp |
| **Cardápio do dia** | Montar o cardápio de cada dia. Tem modelo "Dia comum" e "Sábado (feijoada)", copiar o último dia, marcar item como esgotado, **baixar a imagem para o Status** e copiar o texto |
| **Contatos e envio** | Lista de clientes, importar contatos e **enviar o cardápio do dia para todos** |
| **Simulador** | Testar o robô como se fosse um cliente no WhatsApp |
| **Configurações** | Taxa de entrega, chave Pix, horário do envio automático, impressora |

## Caixa e contas de clientes

- **Vendido** = todos os pedidos do dia (menos cancelados) = **recebido na hora** + **anotado** + **não finalizado**.
- **Recebido na hora** conta os pedidos finalizados ("Entregue"/"Retirado" no quadro), separados por forma de pagamento. Se o cliente pagou de outro jeito, troque a forma na lista de pedidos da aba Caixa.
- **Anotado**: no balcão, escolha "Anotar na conta (pagar depois)". Pedido de empresa já vem com essa opção marcada. O valor vai para a conta do cliente ou da empresa.
- **Receber pagamento** de quem anotou: aba Clientes > cliente > "Receber pagamento". O valor entra no caixa do dia em que foi recebido.
- **Dinheiro na gaveta**: troco inicial + dinheiro recebido − retiradas = quanto deveria ter. Digite o que contou e o sistema mostra se sobrou ou faltou.
- **Anotar pelo WhatsApp**: só para clientes liberados (aba Clientes > Editar > "Pode anotar pelo WhatsApp"). Para esses, o robô mostra a opção "Anotar na minha conta".
- A conta do cliente é aberta sozinha quando o pedido tem empresa, telefone (todo pedido do WhatsApp) ou é anotado. Cadastro repetido se resolve em Editar > "Juntar com este".

## Como o robô conversa

O cliente responde com números: menu, marmita, tamanho, feijão, adicionais, quantidade, observação (ex.: "sem abobrinha"), mais marmitas, nome, retirada ou entrega (guarda o endereço para a próxima vez), pagamento (com troco) e confirmação.
Ao confirmar, o pedido aparece no painel e sai na impressora da cozinha. Quando o balcão marca "pronto" ou "saiu para entrega", o cliente é avisado.

Palavras que funcionam a qualquer momento: **menu**, **cancelar**, **atendente**, **sair** (para de receber o cardápio diário).

## Impressora térmica da cozinha

Qualquer impressora térmica ESC/POS (Epson, Elgin, Bematech, Knup, genéricas de 80 mm ou 58 mm).

- **Impressora de rede (recomendado)**: com cabo de rede ou Wi-Fi. Configure o IP dela em Configurações, modo "Rede". Fica na cozinha sem cabo até o balcão.
- **Impressora USB**: ligue no computador, instale o driver, compartilhe a impressora no Windows (ex.: nome `COZINHA`) e use o modo "USB compartilhada" com `\\localhost\COZINHA`.
- **Arquivo**: modo de teste; o cupom é salvo em `data/impressoes`.

**Pedido de empresa**: o cupom da cozinha traz um **resumo** (quantas de cada tipo), depois cada marmita com o **nome do funcionário** e a observação dele. Em seguida sai uma **etiqueta por marmita**, com o nome em letra grande, para colar na tampa (dá para desligar em Configurações). No quadro, "🖨 Imprimir" reimprime só o cupom e "🏷 Etiquetas" reimprime só as etiquetas.

## WhatsApp

Usa a **API oficial** no **mesmo número do celular** (coexistência). Quem instala vira **Tech Provider** da Meta e conecta cada cliente com a ferramenta `ferramentas/conectar-cliente.js` (`npm run conectar`, abre em http://localhost:4000), sem mensalidade. Enquanto não estiver configurado, o sistema fica em modo **simulador**.
O passo a passo está em **[GUIA-WHATSAPP-OFICIAL.md](GUIA-WHATSAPP-OFICIAL.md)**.

- O robô responde quem chama (grátis). Mensagens mandadas pelo celular aparecem no painel e tiram o robô daquela conversa.
- O cardápio da manhã **não** vai pela API (seria cobrado por contato): o painel gera a **imagem do cardápio** para postar no Status ou no Canal, sem custo. O envio pela API existe, mas vem desligado.
- O sistema abre duas portas: **3000** (painel, só na loja) e **3001** (só o `/webhook`, que vai para a internet pelo túnel).
- Também aceita o parceiro 360dialog ou a API da Meta preenchida à mão.

## Teste automático

```
node scripts/teste.js        # robô, pedido, impressão e envio do cardápio
node scripts/teste-caixa.js  # fechamento de caixa, contas de clientes e extrato
node scripts/teste-meta.js   # integração com a API oficial (usando uma Meta simulada)
node scripts/teste-provedor.js  # ferramenta de conexão do Tech Provider
```
