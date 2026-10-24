# Concordo

Bate-papo entre amigos que roda no seu PC. Sem cadastro e sem servidor de terceiros:
quem hospeda a sala é o computador de um de vocês, e os outros entram por um código de convite.

**O que já funciona:** texto em tempo real, canais, envio de arquivos e imagens, convites por código ou link,
lista de membros com presença, notificações, atualização automática pelo GitHub e, desde a v0.2,
**canais de voz com microfone, câmera e compartilhamento de tela**.

## Como usar

**Quem hospeda**

1. Abra o Concordo e clique em **Hospedar**. Escolha um apelido e o nome da sala.
2. Espere o status ficar **Online** (o túnel abre sozinho; na primeira vez pode baixar o `cloudflared`).
3. Clique em **Convidar**, gere um convite e mande o código para o amigo.
4. Deixe o app aberto enquanto a galera estiver conversando.

**Quem entra**

1. Abra o Concordo, clique em **Entrar**, cole o código e escolha um apelido.
2. Na próxima vez, a sala aparece em **Suas salas**. Como o endereço do túnel muda toda vez que o host reinicia a sala,
   o host manda um **código para quem já entrou** (botão no painel de convite) e você cola em **Entrar**:
   ele reconhece você, sem gastar convite.

**Voz, vídeo e tela**

1. O dono cria um canal em **+ → Voz e vídeo** (já vem um canal `voz`). Clique no canal e em **Entrar na chamada**.
2. Na barra que aparece embaixo da lista de canais: 🎙️ silenciar, 🎧 ensurdecer, 📷 câmera, 🖥️ compartilhar tela, 📞 sair.
3. Clique num vídeo para destacá-lo; o botão ⛶ coloca em tela cheia.
4. **Botão direito** no nome de alguém (na lista, na chamada ou no vídeo) abre o menu com volume da voz (0 a 200%),
   volume da transmissão de tela e *Silenciar para mim*. Os ajustes ficam salvos por pessoa neste computador.
5. O botão ⚙ ao lado do seu nome escolhe microfone, saída de som e câmera (a troca vale na hora, mesmo na chamada) e liga ou
   desliga cancelamento de eco, supressão de ruído e ajuste automático de volume.
6. Em ⚙ há também a **qualidade da transmissão**, separada para câmera e tela: resolução (até 1440p ou a original da tela),
   taxa de quadros (15, 30 ou 60 fps) e taxa de dados máxima por espectador. Em *Automática*, o upload é dividido entre quem
   está assistindo. A mudança vale na hora, mesmo durante a transmissão; 15 fps é bom para texto e slides, 60 fps para jogos.
7. Atalhos com a chamada aberta: **Ctrl+Shift+M** silencia o microfone e **Ctrl+Shift+D** ensurdece (valem com o app em foco).
8. Ao compartilhar a tela, escolha a tela ou janela. O som do computador é opcional e desligado por padrão: ele inclui a
   voz dos amigos, que ouviriam eco. Use fones se ligar.

Os dados da sala (usuários, mensagens e arquivos) ficam na pasta do aplicativo no computador do host.

## Como funciona

```
 amigo (Concordo)  ──https/wss──▶  túnel Cloudflare  ──▶  servidor local (host)
                                                            ├─ HTTP + WebSocket (127.0.0.1)
                                                            ├─ state.json / messages.jsonl
                                                            └─ uploads/
```

- O servidor roda **dentro do app do host** e só escuta em `127.0.0.1`.
- O acesso de fora vem do [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
  (grátis, sem conta). O `cloudflared` vai embutido no instalador.
- O código de convite é `concordo://join/<dados>` e carrega o endereço do túnel, o id da sala e um convite
  de uso limitado e validade de 24 h. Cada pessoa recebe um token próprio ao entrar.
- Voz e vídeo **não passam pelo túnel**: são WebRTC direto entre os apps (malha, cada pessoa envia para todas as outras).
  O servidor da sala só repassa a sinalização. O endereço IP de cada participante fica visível para os outros da chamada.
- Mensagens e nomes são exibidos como texto puro (nada de HTML). Arquivos nunca são servidos como páginas.

## Limites conhecidos

- **O host precisa estar com o app aberto** (e o PC ligado). Fechou, a sala some até ele abrir de novo.
- **Por padrão, o endereço do túnel muda a cada vez que o host inicia a sala.** Quick tunnels são pensados para testes e não têm garantia de disponibilidade.
  Para um endereço fixo, use um túnel nomeado da Cloudflare (precisa de conta e domínio; veja abaixo).
- **Arquivos:** até 90 MB cada (o plano grátis da Cloudflare corta uploads perto de 100 MB).
- **Windows avisa "app desconhecido"** na primeira instalação, porque o instalador não é assinado.
  Clique em *Mais informações → Executar assim mesmo*. As atualizações seguintes não pedem isso de novo.
- **Chamadas:** máximo de 8 pessoas por canal de voz, mas por ser malha o conforto real é de 4 a 5 (quem compartilha tela
  envia o vídeo para cada pessoa). Em redes muito restritivas (CGNAT/NAT simétrico) a conexão direta pode falhar; nesse caso
  o host pode configurar um servidor TURN (veja abaixo).
- Pensado para **grupos pequenos de amigos de confiança**. Quem tem o convite entra; o dono da sala pode remover membros.

### Se o host sumir: sucessor

Toda sala tem um **sucessor** (🛡️): por padrão, o primeiro amigo que entrou. O dono pode trocar passando o mouse sobre
um membro e clicando em 🛡️. O app do sucessor guarda uma cópia da sala neste computador (mensagens, arquivos, membros),
atualizada a cada ~45 segundos.

- Se o host cair, o sucessor vê o aviso **"O host parece ter saído"** e pode clicar em **Assumir a sala**: o computador dele
  vira o servidor com a cópia, ele vira o dono e o app mostra um **código novo**.
- O sucessor manda esse código aos amigos por onde vocês conversam fora do Concordo. Cada um cola em **Entrar** e volta para
  a sala com o mesmo histórico e a mesma conta, sem convite novo (o endereço mudou, então esse envio é manual).
- A assunção é sempre uma decisão do sucessor (nada de dois servidores ao mesmo tempo). Se o host original voltar, ele deve
  entrar na sala nova pelo código, não reabrir a antiga.
- O sucessor recebe uma cópia completa da sala, inclusive os dados de acesso dos membros: escolha alguém de tanta confiança
  quanto o host.
- Mensagens enviadas depois da última cópia (até ~45 s antes de o host cair) podem se perder.

### Endereço fixo (opcional)

Na tela **Hospedar uma sala**, abra **Endereço fixo (avançado)**:

1. No Cloudflare Zero Trust, crie um túnel (Networks → Tunnels → Create tunnel → Cloudflared) e copie o **token**.
2. Em *Public hostname*, aponte o seu endereço (ex.: `chat.seudominio.com`) para `HTTP` + `localhost:47800`.
3. Cole o endereço e o token no Concordo. Eles ficam salvos só no seu computador (o token é criptografado pelo sistema).

Com isso o convite nunca muda: quem já entrou reconecta sozinho quando você abre a sala, sem código novo.
Se a porta 47800 estiver ocupada, troque no próprio campo (e no painel da Cloudflare).

### Servidor TURN (opcional)

Por padrão o Concordo usa servidores STUN públicos (Cloudflare e Google) para os computadores se acharem. Se alguém não
conseguir entrar na chamada, o host pode iniciar o app com um TURN próprio (ex.: coturn), definindo antes a variável
`CONCORDO_ICE_SERVERS` com uma lista JSON, por exemplo no PowerShell:

```powershell
$env:CONCORDO_ICE_SERVERS='[{"urls":"turn:meu-servidor:3478","username":"usuario","credential":"senha"}]'
& "$env:LOCALAPPDATA\Programs\Concordo\Concordo.exe"
```

A lista é entregue a todos os membros pelo servidor da sala.

## Desenvolvimento

Requer Node 20+.

```bash
npm install
npm start        # abre o app em modo desenvolvimento
npm test         # testes do servidor e do túnel
```

Em desenvolvimento, o túnel usa o `cloudflared` de `build/bin/` (se existir) ou baixa um para a pasta do usuário.
Para testar com dois "amigos" na mesma máquina, abra o app uma vez como host e use o código de convite
em um segundo computador (o app permite uma instância por máquina).

Estrutura:

```
src/main/       processo principal do Electron (janela, túnel, atualização, links concordo://)
src/server/     servidor de sala (HTTP, WebSocket, persistência em disco)
src/renderer/   interface (HTML/CSS/JS puro, sem build)
src/shared/     código de convite, usado pelos dois lados
test/           testes (node:test)
```

## Publicar uma versão (GitHub Releases)

É automático. Para lançar uma versão nova:

1. Suba o número em `package.json` (`"version": "0.2.1"`, por exemplo) e faça o commit na `main`.
2. Só isso. O workflow `.github/workflows/release.yml` vê que a tag `v0.2.1` ainda não existe, roda os testes,
   gera o instalador do Windows e cria a Release (e a tag) com `Concordo-Setup-X.Y.Z.exe`, `.blockmap` e `latest.yml`.

Commits que não mudam a versão não geram Release. Quem já tem o app instalado recebe a versão nova sozinho:
o app confere ao abrir, baixa em segundo plano e mostra o botão **Reiniciar e atualizar**.
Na primeira vez, mande aos amigos o link da página de Releases.

Se o host atualizar com a sala aberta, a sala é encerrada (o app pede confirmação).

## Roadmap

1. ~~Voz, vídeo e compartilhamento de tela~~ (feito na v0.2). Ideias seguintes: escolher microfone/saída de som, SFU opcional para salas maiores.
2. ~~Endereço fixo via *named tunnel*~~ (feito na v0.2.1).
3. ~~Migração de host: outro membro assume a sala quando o host sai~~ (feito na v0.4.0, com troca de endereço manual).

## Identidade visual (v0.6.0)

- Tokens de cor/raio/movimento em `src/renderer/styles/tokens.css`, temas **escuro**, **claro** e **automático** (Configurações → Aparência).
- Ícones em `src/renderer/assets/icons/*.svg` (24×24, contorno 1.8, `currentColor`). Depois de editar/trocar um SVG rode `npm run icons` para regenerar `src/renderer/icons.js`.
- Símbolo e ícone do app em `src/renderer/assets/brand/`; `build/icon.ico` é usado no instalador.
- Fonte: Inter se instalada, com fallback Segoe UI.

## v0.7.0

- **Endereço automático:** a cada abertura o túnel temporário muda de endereço. O host publica o endereço atual num bloco público gratuito (jsonblob.com), assinado com uma chave que só os membros têm (vem no código de convite e no `/api/me`). Os amigos procuram o novo endereço sozinhos ao reconectar; só é preciso um código novo **uma vez**, para quem entrou antes desta versão. Se o ponto de encontro estiver fora do ar, o código de sessão manual continua funcionando.
- **Migração automática:** se o host some por ~1 minuto, o sucessor assume a sala sozinho e os amigos o seguem pelo mesmo ponto de encontro.
- **Reações:** figurinhas do mascote (`src/renderer/assets/mascot`) e emojis em mensagens e ao vivo na chamada (botão de carinha na barra de chamada).
- **Áudio da tela:** ligado por padrão; tenta excluir a voz dos amigos e, se o Windows não entregar áudio assim, pede o som do sistema inteiro.

## v0.8.0

- **Bandeja do sistema:** fechar a janela deixa o Concordo rodando em segundo plano (ícone perto do relógio; botão direito → Sair). Configurações permite desligar isso e abrir junto com o Windows. Sair pela bandeja avisa se você está hospedando.
- **Várias salas:** barra lateral com a sala que você hospeda e as salas dos amigos; clique para trocar sem derrubar a sua. Salas fora da tela mostram contador de mensagens novas e notificam. Limitação: a cópia de sucessor e a chamada de voz só funcionam na sala aberta.
- **Erro 530:** quando o host fecha o app, a mensagem agora diz que a sala está offline em vez de "erro 530".

## v0.9.0

- **Passar a sala sem fechar o app:** Encerrar → "Passar a sala para <sucessor>". O sucessor assume na hora, os amigos reconectam sozinhos pelo endereço automático e voltam para a chamada. Fechar o app (ou sair pela bandeja) faz o mesmo se o sucessor estiver online.
- **Onde ficam os dados:** mensagens e arquivos ficam no computador do host e numa cópia no computador do sucessor (atualizada a cada ~45 s e na hora da passagem). Os demais só guardam o que estão vendo na tela.
- **Sons:** entrar/sair da chamada, outra pessoa entrar/sair, mutar, ensurdecer, câmera e tela, queda de conexão. Sintetizados no app, com liga/desliga e volume em Configurações.
- **Chat:** responder, editar, apagar, fixar, buscar (todos os canais), @menções com sugestão e aviso só quando citam você, "fulano está digitando…".

## v0.10.0

- **Todos guardam cópia:** cada membro mantém, em segundo plano, uma cópia da sala (mensagens, arquivos e membros) no próprio computador. As cópias **não levam tokens nem convites**: ninguém consegue se passar por outro membro com a cópia. Se o host sair, assume quem tem cópia e vem primeiro na ordem de sucessão (quem entrou antes); os demais esperam um pouco e só assumem se ninguém publicou o endereço novo. Dá para desligar em Configurações (a cópia usa disco).
- **Voz:** indicador de qualidade de conexão por pessoa (ping e perda de pacotes), destaque animado de quem está falando e seletor de tela em duas etapas (abas Telas/Janelas, prévia ao vivo, ícone do app).
- **Mascote:** na boas-vindas, nos estados vazios e como ícone do app (instalador, janela e bandeja).

## v0.11.0

Cópias que se afastam passam a se juntar sem perder nada, e a sala sabe se já está aberta.

- **Identidade da sala**: é um ID aleatório (vai no convite), nunca o nome. Duas salas com o mesmo nome são independentes e não se misturam.
- **Geração (epoch)**: cada vez que alguém assume ou reabre a sala, a geração sobe. O host antigo que voltar com geração menor percebe pelo ponto de encontro e entra como membro, em vez de manter uma sala paralela. Se dois reabrirem ao mesmo tempo, vence a maior geração e, na igualdade, o menor id de dono.
- **Linha do tempo**: o arquivo de mensagens ganha uma "linha do tempo" nova a cada troca de host; cópias antigas baixam tudo de novo em vez de emendar bytes de arquivos diferentes. Uma cópia nunca é sobrescrita por um host de geração menor.
- **Junção por ID**: ao entrar numa sala reaberta de uma cópia mais velha, o app devolve ao host o que só a sua cópia tem (mensagens, usuários, canais, edições, anexos). Mensagens têm ID único, então nada duplica nem some. Quem foi removido não ressuscita.
- **Suas salas**: a tela inicial mostra se cada sala está aberta ("hospedada por fulano") ou fechada, e oferece **Reabrir com a minha cópia (há 3 dias)**. Antes de abrir, o app espera alguns segundos e confere o ponto de encontro: se alguém já abriu, você entra nessa sala.
- Limites: sem votação, dois membros podem abrir a sala no mesmo instante; a sala se corrige sozinha em segundos e as mensagens dos dois lados são juntadas. As mensagens ainda não são assinadas (próxima versão): a junção confia nos membros da sala.

## v0.11.1

- **Sem popups do Windows por padrão**: mensagem nova toca um som curto, põe um contador vermelho no ícone da barra de tarefas e faz o ícone piscar. O contador zera quando você volta ao app.
- Em Configurações → "Avisar de mensagens novas" dá para escolher popup só quando citarem você, popup em tudo, ou nenhum aviso.
- Fechar pelo X não mostra mais o aviso "continua aberto": o ícone na bandeja já indica.

## v0.12.0

- **Várias salas hospedadas ao mesmo tempo**: "Hospedar" agora sempre cria uma sala NOVA (antes só reabria e renomeava a que já estava ativa). Cada sala tem sua pasta (`host-data/<id>`) e seu próprio túnel; as outras continuam funcionando enquanto você usa uma. O endereço fixo (túnel nomeado) vale para a primeira sala.
- **Suas salas** na tela inicial lista também as que você hospeda: "aberta neste computador" (Voltar) ou "fechada" (Abrir). A barra lateral mostra todas, e abrir uma fechada é um clique.
- A sala única das versões anteriores é movida sozinha para a nova estrutura na primeira abertura.

## v0.13.0

- **Transmissão de tela sem cortes**: a tela em destaque passava da altura da janela e o fundo era cortado; agora ela sempre aparece inteira (com barras pretas quando a proporção for outra), tanto em destaque quanto na grade e nas miniaturas. Zoom e arrastar para escolher uma parte ficam como ideia futura (tela cheia continua).
- **Indicador de internet e disco** no canto da barra lateral (`↓ 12 KB/s ↑ 3 KB/s · 38 MB em disco`). Clique para ver sessão, hoje e mês por tipo (mensagens e arquivos, voz/vídeo/tela, servidor das salas que você hospeda) e o disco por sala. Dá para ocultar ali ou em Configurações. Os números são estimativas do que o app contou: o tráfego do Windows tem cabeçalhos extras, atualizações e o túnel.
- **Anexos nas cópias**: nas Configurações dá para escolher guardar nas cópias das salas todos os anexos, só até 10 MB (padrão) ou nenhum. Mensagens e metadados sempre vêm; só os arquivos grandes deixam de ser baixados (menos disco e menos internet do host).

## v0.14.0

- **Apertar para falar**: em Configurações → Áudio, ligue "Apertar para falar" e escolha a tecla (padrão V). Com isso você entra na chamada mudo e o microfone só abre enquanto segura a tecla (com 0,25 s de folga ao soltar, para não cortar o fim da frase). Não dispara enquanto você digita num campo. Vale com a janela do Concordo em foco: ver teclas de outros programas exigiria um gancho nativo do Windows, que fica de fora por enquanto.
- **Atalhos globais** (desligados por padrão, para não brigar com outros apps): Ctrl+Shift+M muta e Ctrl+Shift+D ensurdece mesmo com outro programa em primeiro plano.
- **Tela compartilhada**: botão de janela flutuante (fica por cima de outros apps) e botão para alternar entre mostrar inteira e preencher o quadro. Tela cheia continua. Supressão de ruído e qualidade da tela (resolução, quadros, taxa) já existiam nas Configurações.

## v0.15.0

- **Meu perfil** (clique no seu nome, embaixo à esquerda): foto (reduzida para 96×96 antes de ir para a sala), cor do nome e do avatar, situação (online, ausente, não perturbe, invisível) e uma frase curta. Todos na sala veem; invisível aparece como offline para os outros; não perturbe silencia os sons de mensagem.
- **Aparência** (Configurações): cor de destaque, tamanho do texto e densidade das mensagens. Valem só neste computador.
- **Silenciar canal**: o sino ao lado do canal tira o contador e o som dele (menções a você ainda avisam). Guardado por sala, neste computador.
- Ficaram para depois: ícone e faixa da sala, emojis personalizados.

## v0.16.0

- **Formatação nas mensagens**: `**negrito**`, `*itálico*`, `~~riscado~~`, `` `código` ``, blocos de código com três crases e citação com `> `. Tudo é montado sem HTML (o que alguém digitar com `<tags>` aparece como texto). Links e @menções continuam funcionando.
- **Linha de "Novas mensagens"** ao entrar num canal com mensagens que você ainda não viu, e também quando chegam com a janela sem foco. **Botão direito no canal** marca como lido.
- **Rascunho por canal**: o que você estava digitando fica guardado ao trocar de canal (inclusive ao reabrir o app) e some ao enviar.
- Colar imagem (Ctrl+V) já funcionava desde antes: a imagem é enviada como anexo.

## v0.17.0

- **Mensagens assinadas**: cada pessoa tem um par de chaves por sala (Ed25519), guardado neste computador de um jeito que o app usa mas ninguém consegue copiar. Mensagens, edições e arquivos saem assinados e todo mundo confere: selo de escudo quando está certo, destaque vermelho se a assinatura não bate, aviso amarelo se uma pessoa que sempre assina mandou algo sem assinatura. Assim nem o host, nem quem guarda uma cópia da sala, consegue fazer uma mensagem aparecer como sendo de outra pessoa. Quem ainda está num app antigo continua falando normalmente, sem selo.
- **Chave fixada**: a chave de cada pessoa fica guardada no primeiro contato. Se ela mudar depois, o app avisa; o menu da pessoa (botão direito) tem "Confiar na nova chave". Quem trocou de computador precisa que o dono ou um moderador use "Liberar chaves de segurança" no menu dela.
- **Conversas diretas cifradas de ponta a ponta** (botão de balão no nome do membro, ou botão direito → Mensagem direta). Só texto, até 3000 caracteres, sem arquivos nem edição nem fixar. O host e as cópias guardam apenas o texto cifrado; a outra pessoa da sala nem vê que a conversa existe. No topo há um código de segurança: se os dois virem o mesmo código (por ligação ou pessoalmente), ninguém está no meio. Limite honesto: o host ainda enxerga quem fala com quem e quando.
- **Cargos**: o dono pode tornar alguém **moderador**. Moderadores apagam mensagens de membros, expulsam e banem membros comuns e liberam chaves. Só o dono promove, convida e mexe em canais.
- **Expulsar ou banir**: banir bloqueia a chave de segurança da pessoa, então o mesmo computador não volta nem com convite novo. Se a pessoa apagar os dados do app e gerar uma chave nova, um convite ainda deixa ela entrar; a proteção real é só convidar quem você conhece.
- **Convites abertos**: o dono vê os convites que ainda valem (usos e validade) e pode revogar.
- **Apagar sala**: na lista "Suas salas", o botão de lixeira ao lado de uma sala que você hospeda apaga os dados dela neste computador (com confirmação do sistema). Quem tem cópia como sucessor continua com a dele.

## v0.18.0

- **Enquetes**: botão de gráfico ao lado do campo de mensagem. Pergunta, de 2 a 6 opções e, se quiser, "mais de uma resposta". Clique numa opção para votar (clique de novo para tirar o voto); passe o mouse para ver quem votou. Quem criou (ou o dono/moderador) pode encerrar. A enquete em si é assinada como qualquer mensagem; **os votos não são assinados**, então quem hospeda a sala poderia, tecnicamente, alterar a contagem.
- **Soundboard**: na chamada, o botão de alto-falante toca um som para todo mundo (buzina, tambor, palmas, trombone triste, sirene, sino, laser, tada). Só o id do som viaja pela rede; cada computador sintetiza o som localmente, então não há arquivos nem uso de dados. Intervalo de 1,5 s entre sons; dá para desligar e ajustar o volume em Configurações de voz. Sons enviados pelos próprios usuários ainda não existem.

## v0.19.0

- **Zoom na tela compartilhada**: role o mouse sobre a tela de alguém para aproximar (até 8x, na direção do cursor), arraste para mover a imagem, dê duplo clique ou clique em "% ✕" para voltar ao normal. Arrastar não troca o foco do quadro.

## v0.20.0

- **Confirmação de leitura**: quando a sua última mensagem do canal (ou da conversa direta) já foi lida, aparece "Visto por Ana, Beto" embaixo dela, com as fotinhos de quem leu. É guardado só o horário da última mensagem lida por canal. Em Meu perfil dá para desligar: desligada, o seu app não avisa que você leu e também não mostra a leitura dos outros. Quem hospeda a sala vê esses horários, como vê o resto dos metadados.

## v0.21.0

- **Sons personalizados**: no soundboard, "＋ Adicionar som" envia um WAV, MP3 ou OGG de até 6 segundos e 200 KB para a sala (até 3 por pessoa e 12 por sala; dono e moderadores não têm o limite por pessoa). O som aparece na seção "Da sala" para todos tocarem na chamada. Quem enviou, o dono ou um moderador pode apagar. O servidor confere que o arquivo é mesmo um áudio e cada app baixa o som uma única vez.
