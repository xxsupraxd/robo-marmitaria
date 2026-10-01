# Ligar o robô no WhatsApp oficial, no mesmo número, sem mensalidade

Você vira **Tech Provider** (provedor de tecnologia) da Meta. Com isso, conecta o WhatsApp Business de cada cliente ao robô **no mesmo número do celular** (coexistência), sem pagar parceiro.

- **Parte 1** é feita **uma vez só**, por você, na sua empresa.
- **Parte 2** é feita **para cada cliente**, junto com ele e com o celular dele na mão.

## Quanto custa

- **Meta**: sem mensalidade. Responder clientes é grátis, e mensagens mandadas pelo celular continuam grátis.
- **ngrok** (deixa a Meta entregar as mensagens no computador do cliente): plano grátis, uma conta por cliente.
- Só teria custo se ligasse o envio do cardápio pelo robô (cerca de R$ 0,32 por contato). Isso vem **desligado** no sistema; o cardápio vai pela imagem no Status ou no Canal.

## Parte 1: virar Tech Provider (uma vez só)

Os nomes dos menus da Meta mudam com frequência; se algo não bater, procure pelo nome em inglês entre parênteses.

1. **Portfólio empresarial**: em business.facebook.com, crie (ou use) o portfólio da **sua** empresa.
2. **Verificação do negócio** (Business verification): em Configurações do negócio > Central de segurança, envie CNPJ, endereço e site/Instagram. Sem isso não dá para ser Tech Provider.
3. **App**: em developers.facebook.com > Meus apps > Criar app > tipo **Empresa** (Business), ligado ao seu portfólio. Adicione o produto **WhatsApp**.
4. **Chaves do app**: em Configurações do app > Básico, copie o **ID do app** (App ID) e a **Chave secreta do app** (App Secret).
5. **Tornar-se Tech Provider**: no painel do app, siga as etapas de **Provedor de tecnologia** (Tech Provider onboarding). Elas pedem a verificação do negócio e a revisão do app.
6. **Revisão do app** (App Review): peça **Acesso avançado** (Advanced Access) para `whatsapp_business_messaging` e `whatsapp_business_management`. A Meta pede um vídeo mostrando o uso: grave a ferramenta conectando um número e o robô respondendo. Pode levar algumas semanas.
   - Enquanto a revisão não sai, dá para testar tudo com números da **sua própria** empresa.
7. **Configuração do Cadastro Incorporado** (Embedded Signup): em **Login do Facebook para Empresas** (Facebook Login for Business) > Configurações, crie uma configuração do tipo **Cadastro Incorporado do WhatsApp**. Copie o **ID da configuração** (Configuration ID).
   - Em Login do Facebook para Empresas > Configurações, adicione `localhost` (ou o endereço https onde você abrir a ferramenta) nos domínios permitidos do SDK JavaScript.
8. **Webhook padrão do app**: em WhatsApp > Configuração, cadastre um endereço seu (pode ser o sistema rodando no seu computador com ngrok) e assine os campos **messages**, **smb_message_echoes**, **history** e **smb_app_state_sync**. Cada cliente depois recebe um endereço próprio, que a ferramenta configura sozinha.
9. **Ferramenta de conexão**: no seu computador, rode `npm run conectar` uma vez (cria o arquivo `ferramentas/provedor.json`). Preencha nele `appId`, `appSecret` e `configId` e rode de novo. Abra **http://localhost:4000**.

> O arquivo `ferramentas/provedor.json` tem a chave secreta do seu app e o `ferramentas/clientes.json` tem os acessos dos clientes. Eles ficam só no seu computador: não mande para ninguém nem copie para o computador dos clientes.

## Parte 2: conectar um cliente

### No computador do balcão do cliente

1. Instale o Node.js e o sistema (é só descompactar e abrir o `iniciar.bat`).
2. Crie uma conta grátis no ngrok **para o cliente**, instale e pegue o domínio fixo dele (ex.: `tempero.ngrok-free.app`). Rode: `ngrok http --url=tempero.ngrok-free.app 3001`
3. Deixe o painel aberto em Configurações > WhatsApp.

### Na sua ferramenta (http://localhost:4000)

1. **Atualize o WhatsApp Business** no celular do cliente.
2. Clique em **Conectar WhatsApp do cliente**. O cliente entra com o **Facebook dele**, escolhe **conectar o WhatsApp Business existente**, confirma o número e lê o **QR code** no aplicativo. Quando perguntar, pode aceitar compartilhar o histórico de conversas.
3. A ferramenta mostra o **código de conexão**. Cole ele no painel do cliente em Configurações > WhatsApp > **Código de conexão** e clique em **Aplicar código**.
4. Volte à ferramenta, preencha o **endereço público do cliente** (`https://tempero.ngrok-free.app`) e clique em **Ativar**. A Meta testa o endereço na hora.
5. Mande um "oi" de outro celular para o número da loja: o robô responde e a conversa aparece no painel.

Faça o passo 4 **no mesmo dia** da conexão: a Meta só deixa puxar os contatos e o histórico nas primeiras 24 horas.

Se o endereço do ngrok do cliente mudar, abra o cliente na lista da ferramenta e clique em Ativar de novo com o endereço novo.

## Regras da coexistência (valem para todo cliente)

- **Listas de transmissão ficam só para leitura** no celular. O cardápio da manhã vai pelo **Status** ou pelo **Canal do WhatsApp**, com a imagem que o painel gera.
- Grupos não aparecem no robô, e mensagens temporárias e de visualização única ficam desligadas.
- Aparelhos conectados (WhatsApp Web, outro celular) são desconectados na ativação.
- O cliente precisa **abrir o WhatsApp Business no celular pelo menos a cada 13 dias**.
- O número precisa já ter um tempo de uso no WhatsApp Business.
- Se alguém responder pelo celular, a mensagem aparece no painel e o robô para de responder aquele cliente (volta depois de 2 horas sem ninguém escrever, ou pelo botão "Devolver para o robô").
- O computador do balcão precisa ficar ligado, com o sistema e o ngrok abertos, no horário de pedidos.

## Outros jeitos que o sistema também aceita

- **360dialog** (parceiro da Meta, € 49 por mês por número): mesmo número, sem precisar virar Tech Provider. Modo "API oficial pelo 360dialog" no painel.
- **API direto na Meta com o número só no robô**: sem mensalidade, mas o número sai do aplicativo do celular. Modo "API oficial da Meta" preenchendo os campos à mão.
