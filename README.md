# isbackup

Sistema de backup configurado por arquivo (sem banco de dados proprio), com
rotinas agendadas via cron. Cada job e de um de dois tipos:

- **Banco de dados** — dump de MySQL/MariaDB via `mysqldump`.
- **Arquivos** — puxa arquivos de um servidor **SFTP ou FTP remoto**, filtra
  por padrao/nome/data de modificacao, e compacta o resultado num `.tar.gz`.

## Como funciona

- Voce descreve os "jobs" de backup (origem — banco ou SFTP/FTP — e a rotina)
  em um arquivo `config.yaml`.
- Toda senha (do banco ou da origem de arquivos) fica cifrada dentro do
  proprio `config.yaml` (`enc:v1:....`, mesma chave mestra pros dois casos)
  ou, no modo antigo, em `.env` referenciada com `${VAR}` — nunca em texto
  puro no `config.yaml`.
- Cada job vira uma entrada no crontab do usuario, que roda `isbackup run <job>`
  no horario configurado.
- Job de banco usa `mysqldump`; job de arquivos usa SFTP/FTP pra listar e
  baixar, e o `tar` do sistema pra compactar. Em nenhum dos dois casos a
  senha aparece na linha de comando ou em log (dump: fica num arquivo
  temporario `0600` apagado logo em seguida).
- Retencao configuravel: backups mais antigos que N dias sao apagados
  automaticamente apos cada execucao bem-sucedida — vale pros dois tipos.

## Pre-requisitos

- Node.js 18+ (testado com Node 26)
- `mysqldump` no PATH (pacote `mysql-client`/`mariadb-client`) na maquina que
  vai rodar os backups. No macOS com Homebrew: `brew install mysql-client` —
  ele e keg-only (nao entra no PATH sozinho), entao depois rode
  `echo 'export PATH="/opt/homebrew/opt/mysql-client/bin:$PATH"' >> ~/.zshrc`
  e abra um terminal novo.
  - O processo que roda o `isbackup` (via cron, ou pela UI) tambem procura o
    `mysqldump` nos caminhos comuns do Homebrew mesmo se o PATH do ambiente
    que o chamou nao os tiver — o cron, por exemplo, roda com um PATH minimo
    que nao inclui `~/.zshrc`, entao sem isso o job falharia so quando
    disparado pelo cron (`spawn mysqldump ENOENT`), mesmo com o mysqldump
    instalado e funcionando manualmente.
- `crontab` disponivel (Linux e macOS ja tem por padrao)

## Instalacao

```bash
npm install
npm run build
npm link   # opcional: deixa o comando `isbackup` disponivel globalmente
```

Sem `npm link`, troque `isbackup` por `node dist/cli.js` nos comandos abaixo.

### Modo rapido: `run.sh`

```bash
./run.sh
```

Instala dependencias (se `node_modules` nao existir), compila e sobe a
interface web — equivalente a `npm install && npm run build && isbackup ui`.
Qualquer argumento extra passa direto pro comando `ui`, por exemplo
`./run.sh --port 9000`.

## Configuracao

```bash
isbackup init
```

Isso cria `config.yaml` e `.env` a partir dos exemplos (`config.example.yaml`
e `.env.example`). Edite os dois.

**config.yaml**

```yaml
defaults:
  port: 3306
  outputDir: ./backups
  retentionDays: 7
  gzip: true

jobs:
  - name: producao
    host: db.exemplo.com
    user: backup_user
    password: ${DB_PRODUCAO_PASSWORD}
    databases: all
    schedule: daily
    retentionDays: 14
```

**.env**

```
DB_PRODUCAO_PASSWORD=senha-real-aqui
```

### Campos de cada job

| Campo           | Obrigatorio | Padrao      | Descricao                                                              |
| --------------- | ----------- | ----------- | ------------------------------------------------------------------------ |
| `name`          | sim         | -           | identificador unico do job                                             |
| `type`          | nao         | `database`  | `database` (mysqldump) ou `files` (puxa de SFTP/FTP) — ausente = `database`, entao jobs antigos continuam funcionando sem mudar nada |
| `schedule`      | sim         | -           | preset (`hourly`, `daily`, `weekly`, `monthly`) ou cron `"0 3 * * *"` (ex: `"0 */4 * * *"` = a cada 4h) |
| `outputDir`     | nao         | `./backups` | pasta onde salvar (relativa ao `config.yaml`); uma subpasta por job    |
| `retentionDays` | nao         | `7`         | backups mais antigos que isso sao apagados apos cada execucao — vale pros dois tipos |
| `paused`        | nao         | `false`     | se `true`, o job fica fora da rotina do cron (`isbackup run` continua funcionando) |

Campos especificos de `type: database`:

| Campo           | Obrigatorio | Padrao      | Descricao                                                              |
| --------------- | ----------- | ----------- | ------------------------------------------------------------------------ |
| `host`          | nao         | `localhost` | host do MySQL/MariaDB                                                  |
| `port`          | nao         | `3306`      | porta                                                                  |
| `user`          | sim         | -           | usuario (pode usar `${VAR}`)                                           |
| `password`      | sim         | -           | senha: `enc:v1:....` (cifrada), `${VAR}` (modo antigo, le do `.env`), ou texto puro (nao recomendado) |
| `databases`     | nao         | `all`       | `all`, um nome, ou lista de nomes                                      |
| `gzip`          | nao         | `true`      | compacta o dump com gzip                                               |

### Job do tipo `files` (origem SFTP/FTP)

Em vez de `host`/`user`/`password`/`databases`/`gzip`, um job `type: files`
tem um bloco `fileSource`:

```yaml
jobs:
  - name: site-producao
    type: files
    schedule: daily
    retentionDays: 14
    fileSource:
      protocol: sftp # ou "ftp"
      host: ftp.exemplo.com
      port: 22 # opcional — default 22 (sftp) / 21 (ftp)
      user: meuusuario
      password: enc:v1:.... # cifrada, mesma chave mestra da senha do banco
      remoteDir: /public_html/logs
      pattern: "*.log" # opcional, wildcard simples (so "*"); default "*" (todos)
      nameContains: erro # opcional, substring no nome (case-insensitive)
      modifiedWithinDays: 7 # opcional, so arquivos modificados nos ultimos N dias
      secure: false # opcional, FTPS — so relevante pra "ftp" (sftp ja e cifrado via SSH)
```

Todos os filtros preenchidos (`pattern`, `nameContains`, `modifiedWithinDays`)
precisam bater ao mesmo tempo — deixe em branco os que nao quiser usar. Os
arquivos que passarem no filtro sao baixados pra uma pasta temporaria e
compactados num `<job>_<timestamp>.tar.gz` (o `tar` do sistema faz a
compactacao — sem dependencia extra), que a partir dai segue o mesmo ciclo de
vida de um dump de banco: listagem, retencao, download, selo de crescimento
de tamanho, self-heal.

**Sobre a data de modificacao**: SFTP/FTP nao expoem "data de criacao" de
forma confiavel (a maioria dos servidores so informa a de modificacao), entao
so esse filtro existe. Alguns servidores FTP tambem tem uma resolucao de
data grosseira (sem ano em arquivos recentes) — o isbackup lida com isso, mas
a precisao no fim depende do que o servidor realmente informa.

## Uso manual

```bash
isbackup list                     # mostra os jobs configurados
isbackup run producao             # roda um job agora
isbackup run --all                # roda todos os jobs agora
isbackup run producao --dry-run   # mostra o que seria feito, sem executar
```

## Ativando a rotina (cron)

```bash
isbackup cron install --dry-run   # revisa o que sera adicionado ao crontab
isbackup cron install             # aplica de fato
isbackup cron status              # mostra as linhas instaladas
isbackup cron uninstall           # remove as linhas do isbackup do crontab
```

`cron install` gera uma entrada por job usando caminhos absolutos (node,
projeto e `config.yaml`), entao funciona independente do diretorio/ambiente
minimo que o cron usa por padrao. As entradas ficam marcadas entre comentarios
`# >>> isbackup managed jobs >>>` / `# <<<`; o resto do seu crontab (se
houver) e preservado. Rodar `cron install` de novo atualiza as entradas caso
voce mude o `config.yaml` (schedule, jobs novos, etc.).

## Seguranca

### Senhas cifradas no config.yaml

```bash
isbackup encrypt "minha-senha-aqui"
# enc:v1:AbCdEf....
```

Cole o resultado direto no campo `password:` do job (`enc:v1:....`). Criar ou
editar um job pela interface web faz isso automaticamente. Por baixo:

- AES-256-GCM (`node:crypto`, sem dependencia externa), chave de 256 bits.
- A chave (`ISBACKUP_ENCRYPTION_KEY`) e gerada sozinha na primeira vez que
  algo e cifrado (CLI ou UI) e fica no `.env` — nunca no `config.yaml`. Todo
  job usa a mesma chave.
- Isso torna o `config.yaml` seguro pra commitar/compartilhar mesmo com as
  senhas cifradas dentro dele: sem o `.env` (a chave), o conteudo cifrado nao
  serve pra nada. **Mas** nao protege contra alguem com acesso a esta
  maquina/pasta inteira (`.env` incluido) — para isso seria preciso uma
  senha-mestra digitada a cada uso, que este projeto nao pede por simplicidade.
  Perdeu o `.env`/a chave? As senhas cifradas ficam irrecuperaveis; edite os
  jobs de novo com a senha real.
- O modo antigo (`${VAR}` lido do `.env`) continua funcionando, sem migracao
  forcada — os dois formatos convivem no mesmo `config.yaml`.

### Outros pontos

- O `.env` (que agora guarda a chave de cifra, e/ou senhas no modo antigo)
  nunca deve ser commitado — ja esta no `.gitignore`.
- A senha e passada ao `mysqldump` via arquivo temporario
  `--defaults-extra-file` (`0600`, apagado logo apos o dump), nunca via `-p`
  na linha de comando (que ficaria visivel em `ps aux` para outros usuarios
  da maquina).
- Os dumps ficam em texto (gzip por padrao, mas nao criptografados). Se forem
  sensiveis, considere um disco/volume cifrado no destino.

## Logs

Cada job grava sua propria saida em `logs/<job>.log` dentro do projeto —
sempre, independente de quem disparou aquele run especifico (cron, "Executar
agora" pela UI, ou o self-heal): o proprio processo escreve no arquivo na
hora, em vez de depender do shell redirecionar a saida do comando do cron
como antes. Isso garante que o "Historico" da UI mostra o que aconteceu em
qualquer situacao — inclusive um job que so rodou (e so falhou) via self-heal
ou pela UI, sem nenhuma execucao via cron ainda.

## Interface web

```bash
isbackup ui              # sobe em http://127.0.0.1:8787
isbackup ui --port 9000  # porta customizada
```

Um dashboard local para ver e gerenciar os backups, tudo sem sair do
navegador. O card de cada job na tela principal mostra so o essencial: nome,
saude e contagem regressiva pro proximo backup (calculada a partir da
expressao cron real, entao lida direito com schedules irregulares tipo "so
dias uteis"). Tudo o resto — executar agora, arquivos, historico,
configuracoes, excluir — fica no menu **⋮** de cada card, pra manter a tela
principal limpa.

A saude de cada job fica destacada por cor, num badge que fica **acima do
nome** no card:

- **Verde ("Em dia")** — existe um backup mais recente que a ultima execucao
  esperada pelo schedule.
- **Vermelho ("Atrasado")** — o horario em que o job deveria ter rodado (pelo
  cron) ja passou e nao ha backup recente o suficiente. Tambem fica vermelho
  ("Falhou") se a ultima execucao disparada terminou em erro — o detalhe do
  erro fica no "Historico" (menu ⋮).
- **Azul ("Rodando…")** — backup em andamento.

Faltando menos de 1 minuto para o proximo backup, o anel e o numero do
relogio piscam em amarelo — um aviso mais chamativo que so a contagem
regressiva descendo. Enquanto algo estiver "Rodando" ou "Atrasado" a tela
tambem passa a se atualizar sozinha (a cada 1.5s) ate resolver — isso evita
o card ficar preso em "Atrasado" so porque o horario esperado acabou de
passar e o cron ainda nao comecou de fato (sempre existe uma folga real
entre os dois): sem atualizacao continua nesse intervalo, so um refresh
manual corrigia o card.

Do lado do badge de status (tambem acima do nome, nao mais em cima do
relogio) aparece um selo comparando o tamanho do ultimo backup com o do
anterior — um jeito rapido de perceber um dump que "deu certo" mas saiu
vazio ou incompleto (conexao caiu no meio, disco cheio etc), ja que o
esperado e o banco (e o arquivo) so crescer:

- **▲ verde** — o ultimo backup ficou maior que o anterior.
- **! amarelo** — o ultimo backup ficou do mesmo tamanho ou menor que o
  anterior. Vale checar o job (passe o mouse pro tooltip com os dois
  tamanhos).
- Sem selo — ainda nao ha dois backups pra comparar.

- **Sem tela de login.** O servidor so escuta em `127.0.0.1` (nao e
  configuravel para outro host), entao so processos na propria maquina
  conseguem acessar. Nao exponha essa porta pela rede (nao coloque atras de
  um reverse proxy ou tunnel) sem antes adicionar autenticacao.
- Le e escreve diretamente em `config.yaml`/`backups/`/`logs/` — os mesmos
  arquivos usados pela CLI e pelo cron. Nao ha banco de dados nem estado
  separado: pode usar a CLI e a UI ao mesmo tempo sem conflito.

### Criar, editar e excluir jobs pela UI

O menu **⋮** no canto de cada card abre "Executar agora", "Arquivos"
(lista de backups, com download/exclusao), "Historico" (log recente do job),
"Configuracoes" (o formulario de edicao) e "Excluir" — tudo num dropdown, em
vez de botoes soltos no card, pra manter a tela principal so com nome, saude
e proximo backup, e reduzir clique acidental numa acao destrutiva. "+ Novo
job" no topo abre um dropdown perguntando o tipo ("Banco de dados" ou
"Arquivos") antes de abrir o formulario ja no tipo certo.

- **Tipo de job**: primeiro campo do formulario — "Banco de dados" ou
  "Arquivos" (via SFTP/FTP). Troca os campos do formulario logo abaixo
  (mesmo mecanismo de mostrar/esconder que a "Rotina" ja usa). Dá pra trocar
  o tipo de um job existente na edicao — o bloco do tipo anterior e limpo do
  `config.yaml`.
- **Testar conexao**: antes de salvar (criar ou editar), "Salvar" fica
  desabilitado ate um "Testar conexao" ter sucesso — pra banco, roda um
  `SELECT 1` de verdade com as credenciais informadas (nao usa
  `mysqladmin ping`: ele retorna sucesso mesmo com senha errada, contanto que
  o servidor responda); pra arquivos, conecta via SFTP/FTP e confirma que o
  diretorio remoto existe. Editar um job existente comeca com "Salvar" ja
  liberado (assume que a conexao salva ainda funciona), mas qualquer mudanca
  num campo de conexao (host, porta, usuario, senha, protocolo, diretorio
  remoto) revoga isso e exige testar de novo. Deixar a senha em branco na
  edicao testa com a senha ja salva (mesmo "deixe em branco pra manter a
  atual" do campo de senha).
- **Nome** nao pode ser alterado depois de criado (usado no diretorio de
  backups, nome do log e tag do cron — trocar exigiria migrar tudo isso).
- **Senha**: no formulario de edicao o campo comeca vazio — deixe em branco
  para manter a senha atual. Quando voce salva uma senha nova (ou cria um
  job), ela e cifrada e gravada direto no `config.yaml` (ver
  [Senhas cifradas no config.yaml](#senhas-cifradas-no-configyaml)) — nunca em
  texto puro.
- **Rotina**: "Diaria", "Semanal" e "Mensal" tem campo de horario (e "Semanal"
  o dia da semana, "Mensal" o dia do mes) — nao ficam mais fixos as 3h. Tem
  tambem "A cada hora" e "A cada N horas" (mais de 1x por dia), os dois com
  uma janela "das X as Y h" opcional pra restringir a quais horas do dia isso
  vale (por padrao 0 as 23 = o dia todo, igual antes) — inicio maior que o
  fim funciona (ex: 22 as 6 = so de madrugada), e inicio igual ao fim vira um
  horario especifico so. Os modos "A cada hora", "A cada N horas", "Diaria"
  e "Dias especificos da semana" tem um seletor **Dom–Sab**: marque os dias em
  que a rotina vale (ex: "a cada 2h, das 8 as 18h, so de segunda a sexta");
  nenhum dia marcado = todos os dias. A projecao de arquivos/dia no
  formulario ja leva os dias em conta. Nenhum precisa escrever cron na mao; todos reconhecem o padrao de
  volta ao editar (um cron `"0 H * * *"` vira "Diaria" com a hora certa,
  `"0 H * * D"` vira "Semanal", uma lista de horas vira a janela de "A cada
  hora"/"A cada N horas", etc.).
- Salvar **reescreve o `config.yaml` inteiro** (via serializacao YAML), entao
  comentarios/formatacao manual que voce tenha colocado no arquivo se perdem
  na primeira edicao feita pela UI. Os dados em si (jobs, defaults) sao
  preservados certinho.
- **Excluir** so tira o job do `config.yaml` — nao apaga os backups/logs que
  ja existem no disco (apague-os manualmente pela lista de backups do job, se
  quiser).
- **Pausar/Retomar**: um job pausado (`paused: true` no `config.yaml`) fica de
  fora da rotina — nao entra na crontab gerada por "Atualizar cron", e o card
  mostra "Pausado" em vez da contagem regressiva. "Executar agora" continua
  funcionando normalmente mesmo pausado (pausa so afeta a rotina automatica).
- Criar/editar/excluir/pausar **nao mexe no cron instalado automaticamente**.
  Se o cron ja estava instalado e algo relevante mudou — jobs ativos, mas
  tambem schedule, retencao, saida etc de um job existente — o badge no topo
  passa a mostrar "Cron desatualizado" com um botao para atualizar; a
  aplicacao real no crontab continua exigindo esse clique explicito. Enquanto
  isso, o crontab real continua rodando com o schedule antigo, entao o card
  do job pode aparecer "Atrasado" mesmo com backups recentes — a saude e
  calculada contra o schedule *atual* do `config.yaml`, nao contra o que
  esta de fato instalado.
- O estado **"Rodando…"** funciona tanto pra "Executar agora" (pela UI)
  quanto pra uma execucao disparada pelo cron (processo separado da UI) — um
  arquivo de lock no proprio `outputDir` do job (`.{job}.running.json`,
  apagado ao final) e a fonte da verdade, entao qualquer um dos dois
  processos consegue ver que o job esta rodando agora.

### Cron e o sono da maquina (self-heal)

O `cron` do macOS **nao roda enquanto a maquina esta dormindo** e, diferente
do `launchd`, **nao recupera** um horario perdido depois — se o minuto exato
de um job cair durante o sono (comum em notebook fechado ou em "Idle
Sleep"/"Maintenance Sleep" durante a madrugada), aquele backup e simplesmente
pulado, sem nenhum erro registrado no log.

Pra cobrir isso, enquanto o `isbackup ui` estiver rodando ele mesmo funciona
como uma rede de seguranca: a cada poucos minutos (e tambem assim que sobe,
o que cobre o caso comum de abrir o notebook de manha) ele confere se algum
job ativo esta atrasado segundo o proprio schedule e, se estiver — e ninguem
ja estiver rodando ele —, dispara o backup na hora sozinho, registrando no
log que foi um catch-up de self-heal. Se a mesma tentativa falhar, ele espera
um tempo antes de tentar de novo (pra nao ficar batendo retry sem parar
contra um problema real, tipo rede fora).

Isso so cobre a janela em que o `isbackup ui` esta de pe — nao substitui o
cron (que continua cuidando do horario normal) nem ajuda se o processo da UI
tambem nao estiver rodando. Se voce quer o servidor sempre disponivel,
configure-o pra subir junto com o login (LaunchAgent, `pm2`, etc).
