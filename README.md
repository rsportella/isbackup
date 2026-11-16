<div align="center">

<img src="docs/icon.svg" width="88" height="88" alt="" />

# isbackup

Backup de bancos MySQL/MariaDB e de arquivos em servidores SFTP/FTP, com agendamento e um painel web
local para acompanhar.

[![CI](https://github.com/rsportella/isbackup/actions/workflows/ci.yml/badge.svg)](https://github.com/rsportella/isbackup/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A5%2022.12-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-8E8E93)](LICENSE)
![Windows, macOS e Linux](https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-000000)

<br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/dashboard-dark.png" />
  <img src="docs/dashboard-light.png" alt="Painel do isbackup com seis jobs: anéis de contagem regressiva até o próximo backup, status em dia, rodando, atrasado e pausado" width="100%" />
</picture>

</div>

## O que é

O isbackup roda `mysqldump` (ou baixa arquivos de um servidor SFTP/FTP) nos horários que você definir,
guarda os arquivos com retenção por dias e mostra num painel o que rodou, o que está atrasado e quando
é o próximo backup.

Não tem banco de dados nem serviço próprio. A configuração fica num `config.yaml`, os backups numa
pasta e o agendamento usa o que o sistema já oferece: o `cron` no macOS e no Linux, o Agendador de
Tarefas no Windows. O painel e a linha de comando leem e escrevem os mesmos arquivos.

Principais pontos:

- Jobs criados pelo painel, com teste de conexão antes de salvar.
- Senhas cifradas no `config.yaml` (AES-256-GCM, chave no `.env`).
- O backup só ganha o nome final depois de gravado por completo. Um dump interrompido não fica
  parecendo um backup válido.
- Alerta quando um backup sai bem menor que o anterior, o que costuma indicar falha no dump.
- Recuperação de horários perdidos: com o painel aberto, um backup que deveria ter rodado enquanto o
  computador estava desligado ou dormindo é feito assim que ele volta.
- Funciona no Windows, no macOS e no Linux, direto na máquina ou via Docker.

## Instalação

Há duas formas de rodar. As duas abrem o mesmo painel em http://127.0.0.1:8787.

### Direto na máquina

Precisa do [Node.js](https://nodejs.org) 22.12 ou mais novo.

macOS e Linux:

```bash
git clone https://github.com/rsportella/isbackup.git
cd isbackup
./run.sh
```

Windows (Prompt de Comando ou PowerShell, ou dois cliques no `run.cmd` depois de baixar o projeto):

```bat
git clone https://github.com/rsportella/isbackup.git
cd isbackup
run.cmd
```

O script instala as dependências, compila, sobe o painel e abre o navegador. Opções: `--port 9000`
para outra porta e `--no-open` para não abrir o navegador.

Para jobs de banco é preciso o cliente do MySQL (`mysqldump` e `mysql`):

- Windows: [MySQL Installer](https://dev.mysql.com/downloads/installer/) ou o
  [instalador do MariaDB](https://mariadb.org/download/). O isbackup procura o cliente em
  `C:\Program Files\MySQL\...\bin`, `C:\Program Files\MariaDB ...\bin` e no XAMPP, mesmo que não
  esteja no `PATH`.
- macOS: `brew install mysql-client`.
- Debian/Ubuntu: `sudo apt install default-mysql-client`. Fedora: `sudo dnf install mariadb`.

Para jobs de arquivos basta o `tar`, que já vem no sistema (Windows 10 1803 ou mais novo).

No Linux, o `cron` precisa estar instalado e ativo. Algumas distribuições mínimas vêm sem ele
(`sudo apt install cron` ou `sudo dnf install cronie`).

### Docker

Precisa só do [Docker Desktop](https://www.docker.com/products/docker-desktop/) (ou outro Docker com
Compose).

```bash
git clone https://github.com/rsportella/isbackup.git
cd isbackup
./docker.sh
```

Na primeira execução o script pergunta em que pasta guardar os dados (configuração, chave das senhas e
backups), constrói a imagem e abre o painel. Se encontrar dados de uma instalação direta na mesma
pasta, ele oferece usar os mesmos e mover o agendamento do crontab do computador para o container,
para que nenhum backup rode duas vezes.

Sem o `docker.sh` (por exemplo, no Windows sem Git Bash ou WSL), use `docker compose up -d` e abra
http://localhost:8787. Nesse caso os dados ficam em `./docker-data`.

<details>
<summary>Mais sobre o modo Docker</summary>

- A imagem já inclui Node, `mysqldump`, `mysql`, `tar` e `cron`. Foi testada com MariaDB 11 e
  MySQL 8.4.
- A pasta escolhida fica anotada em `docker.local.env`, fora do git. Para trocar: `./docker.sh setup`.
- O crontab do container fica num volume próprio e não se perde ao recriar o container.
- Para um banco na sua própria máquina, use `host.docker.internal` como host do job (dentro do
  container, `localhost` é o próprio container).
- Fuso horário e porta: `TZ=America/Recife ISBACKUP_PORT=9000 ./docker.sh`.
- Outros comandos: `./docker.sh logs`, `./docker.sh down` e
  `docker compose exec isbackup isbackup list`.
- Para atualizar: `git pull && ./docker.sh`.
- Os backups só rodam com o Docker aberto. No Docker Desktop, vale ativar "Start Docker Desktop when
  you sign in".
- Se houver mais de um Docker instalado, o script prefere o Docker Desktop. Para usar outro:
  `DOCKER_CONTEXT=colima ./docker.sh`.

</details>

## Uso

1. No painel, clique em **Novo job** e escolha banco de dados ou arquivos (SFTP/FTP).
2. Preencha a conexão e clique em **Testar conexão**.
3. Escolha a rotina (diária, a cada N horas, só em dias úteis etc.) e salve.
4. Clique em **Instalar rotina** para ativar o agendamento.

A chave que cifra as senhas é criada no `.env` quando o primeiro job é salvo. Nem o `.env` nem o
`config.yaml` vão para o git.

Pelo painel também dá para rodar ou parar um backup, pausar um job, baixar e apagar arquivos, ver o
log de cada job, escolher em que pasta os backups são salvos (e mover os que já existem) e trocar
entre tema claro, escuro ou automático.

<table>
  <tr>
    <td width="50%"><img src="docs/job-form.png" alt="Formulário de edição de um job com rotina a cada hora, das 8 às 18h, de segunda a sexta" /></td>
    <td width="50%"><img src="docs/history.png" alt="Lista de arquivos de backup de um job, com botões de baixar e apagar" /></td>
  </tr>
  <tr>
    <td align="center"><sub>Edição de um job</sub></td>
    <td align="center"><sub>Arquivos de um job</sub></td>
  </tr>
</table>

## Configuração

Os jobs ficam no `config.yaml`. Dá para editar à mão (veja o
[`config.example.yaml`](config.example.yaml)):

```yaml
defaults:
  outputDir: ./backups # uma subpasta por job
  retentionDays: 7

jobs:
  - name: loja-producao
    host: db.exemplo.com
    user: backup
    password: enc:v1:Q2hh... # gerada com: isbackup encrypt "sua-senha"
    databases: [loja, pagamentos] # ou: all
    schedule: daily # hourly | daily | weekly | monthly | "0 3 * * *"
    retentionDays: 14

  - name: site-uploads
    type: files
    schedule: "0 1 * * *"
    fileSource:
      protocol: sftp # ou ftp
      host: files.exemplo.com
      user: deploy
      password: enc:v1:Zm9v...
      remoteDir: /var/www/uploads
      pattern: "*.jpg" # opcional; só "*" é curinga
      modifiedWithinDays: 7 # opcional
```

Salvar pelo painel regrava o arquivo inteiro, então comentários escritos à mão se perdem.

<details>
<summary>Todos os campos</summary>

Comuns aos dois tipos:

| Campo | Padrão | Descrição |
|---|---|---|
| `name` | obrigatório | Identificador único. Só letras, números, `-` e `_`. |
| `type` | `database` | `database` ou `files`. |
| `schedule` | obrigatório | Preset (`hourly`, `daily`, `weekly`, `monthly`) ou expressão cron de 5 campos. |
| `outputDir` | `./backups` | Pasta de destino, relativa ao `config.yaml`. Cada job usa uma subpasta. |
| `retentionDays` | `7` | Backups mais antigos que isso são apagados (`0` mantém todos). |
| `paused` | `false` | Tira o job do agendamento. `isbackup run` continua funcionando. |

`type: database`:

| Campo | Padrão | Descrição |
|---|---|---|
| `host` / `port` | `localhost` / `3306` | Servidor MySQL/MariaDB. |
| `user` | obrigatório | Usuário. Aceita `${VARIAVEL}` do `.env`. |
| `password` | obrigatório | `enc:v1:...` (cifrada) ou `${VARIAVEL}` do `.env`. |
| `databases` | `all` | `all`, um nome ou uma lista. |
| `gzip` | `true` | Comprime o dump. |

`type: files` (dentro de `fileSource`):

| Campo | Padrão | Descrição |
|---|---|---|
| `protocol` | obrigatório | `sftp` ou `ftp`. |
| `host` / `port` | obrigatório / `22` ou `21` | Servidor remoto. |
| `user` / `password` | obrigatórios | Credenciais. A senha segue o mesmo formato da do banco. |
| `remoteDir` | `/` | Pasta de origem, com subpastas (até 10 níveis). |
| `pattern` | `*` | Padrão do nome do arquivo. Só `*` é curinga. |
| `nameContains` | | Trecho do nome, sem diferenciar maiúsculas. |
| `modifiedWithinDays` | | Só arquivos modificados nos últimos N dias. |
| `secure` | `false` | FTPS. Só vale para `ftp`. |

</details>

## Linha de comando

Para ter o comando `isbackup` no terminal, rode `npm link` uma vez (ou use `node dist/cli.js`).

```bash
isbackup ui [--port 9000] [--open] # sobe o painel
isbackup list                      # lista os jobs
isbackup run <job>                 # roda um job agora
isbackup run --all                 # roda todos
isbackup run <job> --dry-run       # mostra o que faria, sem executar
isbackup cron install [--dry-run]  # instala/atualiza o agendamento
isbackup cron status               # mostra o que está agendado
isbackup cron uninstall            # remove o agendamento do isbackup
isbackup tick [--dry-run]          # roda os jobs do minuto atual (usado no Windows)
isbackup encrypt "senha"           # cifra uma senha para o config.yaml
isbackup init                      # cria config.yaml e .env a partir dos exemplos
```

## Como funciona o agendamento

- **macOS e Linux:** cada job vira uma linha no `crontab` do usuário. As linhas do isbackup ficam
  entre marcadores, e o resto do crontab não é alterado.
- **Windows:** é criada uma tarefa `isbackup` no Agendador de Tarefas, que roda a cada minuto (sem
  abrir janela) e chama `isbackup tick`. O tick executa os jobs cujo horário chegou, então as mesmas
  expressões cron funcionam nos três sistemas.

Na hora marcada, `isbackup run <job>` grava o backup em
`backups/<job>/<job>_AAAAMMDD_HHMMSS.sql.gz` (ou `.tar.gz`), aplica a retenção e escreve no log do
job. Dois processos nunca rodam o mesmo job ao mesmo tempo.

Se o computador estiver desligado ou dormindo no horário, o agendador do sistema não roda o backup
depois. O painel cobre isso: enquanto ele estiver aberto, confere a cada poucos minutos se algum job
está atrasado e o executa.

## Segurança

- As senhas ficam cifradas no `config.yaml`. A chave (`ISBACKUP_ENCRYPTION_KEY`) fica só no `.env`,
  com permissão `600`. Guarde uma cópia da chave: sem ela, as senhas cifradas não podem ser lidas.
- A senha do MySQL é passada ao `mysqldump` por um arquivo temporário com permissão `600`, apagado
  em seguida, e não pela linha de comando, onde apareceria no `ps`.
- Os backups são gravados com permissão `600`, mas não são cifrados. Se o conteúdo for sensível,
  use um disco cifrado no destino.
- O painel não tem login. Ele só escuta em `127.0.0.1` e recusa pedidos endereçados a outro nome
  (proteção contra DNS rebinding) ou vindos de outro site aberto no navegador. Não exponha a porta
  na rede sem autenticação na frente. Para acessar por outro nome atrás de um proxy com login, use
  `ISBACKUP_ALLOWED_HOSTS=backup.lan`.

## Limitações

- Bancos suportados: MySQL e MariaDB (via `mysqldump`).
- No Windows, a tarefa é do usuário: as rotinas rodam enquanto ele estiver conectado.
- Mantenha uma cópia dos backups fora da máquina. Uma cópia no mesmo disco não protege contra a
  perda do disco.

## Desenvolvimento

```bash
npm install
npm run dev -- list   # roda a CLI direto do TypeScript
npm run typecheck
npm test
npm run build
```

Os testes usam diretórios temporários e um `mysqldump` simulado, então rodam sem banco, sem servidor
remoto e sem mexer no crontab. O CI roda tudo no Windows, no Linux e no macOS, e no Windows também
testa a tarefa real do Agendador.

```
src/
  cli.ts            comandos da CLI
  config.ts         leitura, validação e gravação do config.yaml
  dump.ts           backup de banco (mysqldump)
  file-backup.ts    backup de arquivos (SFTP/FTP + tar)
  backups.ts        listagem, retenção e gravação dos arquivos
  scheduler.ts      agendamento: cron ou Agendador de Tarefas
  cron.ts           linhas do crontab
  run-lock.ts       lock entre processos e cancelamento
  crypto.ts         cifra das senhas
  web/              API do painel
public/             painel (HTML, CSS e JS, sem build)
docker/             entrypoint do container
test/               testes
```

## Licença

[MIT](LICENSE) © Rodolfo Portella

---

<div align="center">
  <sub>Desenvolvido por <strong>RSPortella</strong></sub>
  <br /><br />
  <a href="https://github.com/rsportella" title="GitHub"><img src="docs/github.svg" width="28" height="28" alt="GitHub" /></a>
  &nbsp;
  <a href="https://www.linkedin.com/in/rsportella/" title="LinkedIn"><img src="docs/linkedin.svg" width="28" height="28" alt="LinkedIn" /></a>
  &nbsp;
  <a href="https://www.instagram.com/rsportella/" title="Instagram"><img src="docs/instagram.svg" width="28" height="28" alt="Instagram" /></a>
  &nbsp;
  <a href="mailto:rodolfosportella@gmail.com" title="rodolfosportella@gmail.com"><img src="docs/email.svg" width="28" height="28" alt="E-mail" /></a>
  <br />
  <sub><a href="mailto:rodolfosportella@gmail.com">rodolfosportella@gmail.com</a></sub>
</div>
