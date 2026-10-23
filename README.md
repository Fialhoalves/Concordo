# Concordo

Bate-papo entre amigos que roda no seu PC. Sem cadastro e sem servidor de terceiros:
quem hospeda a sala é o computador de um de vocês, e os outros entram por um código de convite.

**O que já funciona (v0.1):** texto em tempo real, canais, envio de arquivos e imagens, convites por código ou link,
lista de membros com presença, notificações, atualização automática pelo GitHub.
**Ainda não tem:** voz, vídeo e compartilhamento de tela (próximo passo, veja o [Roadmap](#roadmap)).

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
- Mensagens e nomes são exibidos como texto puro (nada de HTML). Arquivos nunca são servidos como páginas.

## Limites conhecidos

- **O host precisa estar com o app aberto** (e o PC ligado). Fechou, a sala some até ele abrir de novo.
- **O endereço do túnel muda a cada vez que o host inicia a sala.** Quick tunnels são pensados para testes e não têm garantia de disponibilidade.
  Para um endereço fixo, o caminho é um *named tunnel* da Cloudflare (precisa de conta e domínio).
- **Arquivos:** até 90 MB cada (o plano grátis da Cloudflare corta uploads perto de 100 MB).
- **Windows avisa "app desconhecido"** na primeira instalação, porque o instalador não é assinado.
  Clique em *Mais informações → Executar assim mesmo*. As atualizações seguintes não pedem isso de novo.
- Pensado para **grupos pequenos de amigos de confiança**. Quem tem o convite entra; o dono da sala pode remover membros.

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

1. Crie um repositório **público** no GitHub e envie o código (`git push`). O electron-builder descobre o usuário e o nome do repositório pelo `git remote origin`.
2. Para cada versão nova:

   ```bash
   npm version patch        # ou minor / major: atualiza o package.json e cria a tag vX.Y.Z
   git push --follow-tags
   ```

3. O workflow `.github/workflows/release.yml` roda sozinho: executa os testes, gera o instalador do Windows
   e publica na página de **Releases** (`Concordo Setup X.Y.Z.exe`).
4. Mande o link dessa página para os amigos, **uma vez só**. Depois disso o app confere se há versão nova ao abrir,
   baixa em segundo plano e mostra o botão **Reiniciar e atualizar**.

Se o host atualizar com a sala aberta, a sala é encerrada (o app pede confirmação).

## Roadmap

1. **Voz, vídeo e compartilhamento de tela** com WebRTC direto entre os apps (o servidor só faz a sinalização).
2. Código de convite que não precisa ser reenviado (endereço fixo via *named tunnel*).
3. Migração de host: outro membro assume a sala quando o host sai.
