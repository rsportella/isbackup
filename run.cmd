@echo off
rem Sobe o painel do isbackup no Windows (http://127.0.0.1:8787) e abre o navegador.
rem
rem Uso: de dois cliques neste arquivo, ou no Prompt de Comando / PowerShell:
rem   run.cmd                 porta 8787
rem   run.cmd --port 9000     porta customizada (repassa os argumentos pro "isbackup ui")
rem   run.cmd --no-open       nao abre o navegador sozinho
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Erro: Node.js nao encontrado. Instale a versao 22.12 ou mais nova: https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo Instalando dependencias...
  call npm install
  if errorlevel 1 goto falhou
)

echo Compilando...
call npm run build --silent
if errorlevel 1 goto falhou

rem Primeiro uso (clone novo): config.yaml sem jobs. O painel abre na tela vazia, com "Novo job".
if not defined ISBACKUP_HOME if not exist config.yaml (
  echo Primeiro uso: criando config.yaml vazio ^(crie os jobs pelo painel^).
  > config.yaml (
    echo defaults:
    echo   outputDir: ./backups
    echo   retentionDays: 7
    echo.
    echo jobs: []
  )
)

rem Repassa os argumentos pro "isbackup ui", tirando o --no-open (que e so deste script).
set "UI_ARGS="
set "OPEN=--open"
:args
if "%~1"=="" goto run
if /i "%~1"=="--no-open" (set "OPEN=") else (set UI_ARGS=%UI_ARGS% %1)
shift
goto args

:run
echo Iniciando o isbackup (feche esta janela ou use Ctrl+C para parar)...
node dist\cli.js ui %UI_ARGS% %OPEN%
if errorlevel 1 goto falhou
exit /b 0

:falhou
echo.
echo O isbackup nao conseguiu iniciar. Veja a mensagem acima.
pause
exit /b 1
