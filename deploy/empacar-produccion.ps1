$ErrorActionPreference = 'Stop'
# ============================================================
# Colmena - empaca builds/colmena-produccion.zip
# (codigo + tiles + apk + .env + pbf OSRM; todo lo que NO esta en git)
# Ejecutar desde la raiz del repo:  ./deploy/empacar-produccion.ps1
# ============================================================
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$stage = Join-Path $root 'builds\produccion'
$zip = Join-Path $root 'builds\colmena-produccion.zip'

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
if (Test-Path $zip) { Remove-Item $zip -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

function Stage-Dir([string]$src, [string]$dst) {
    robocopy $src (Join-Path $stage $dst) /E /NFL /NDL /NJH /NJS /NP /XD node_modules dist .git uploads apk_cache /XF "*.log"
    if ($LASTEXITCODE -ge 8) { throw "robocopy fallo en $src" }
}
function Stage-File([string]$src, [string]$dst) {
    $p = Join-Path $stage $dst
    New-Item -ItemType Directory -Path (Split-Path $p) -Force | Out-Null
    Copy-Item $src $p -Force
}

Write-Host "==> Copiando codigo..."
Stage-Dir (Join-Path $root 'src') 'src'
Stage-Dir (Join-Path $root 'db\migrations') 'db\migrations'
Stage-Dir (Join-Path $root 'infrastructure') 'infrastructure'

Write-Host "==> Copiando config y secretos..."
Stage-File (Join-Path $root 'docker-compose.yml') 'docker-compose.yml'
Stage-File (Join-Path $root '.env') '.env'

Write-Host "==> Extrayendo pbf de OSRM desde el volumen..."
New-Item -ItemType Directory -Path (Join-Path $stage 'deploy\osrm-data') -Force | Out-Null
docker run --rm -v colmena_osrm_data:/data -v "$stage\deploy\osrm-data:/out" alpine sh -c "cp /data/guanajuato.osm.pbf /out/" 2>&1 | Out-Null
if (-not (Test-Path (Join-Path $stage 'deploy\osrm-data\guanajuato.osm.pbf'))) {
    Write-Warning "No se encontro guanajuato.osm.pbf en el volumen colmena_osrm_data; OSRM quedara pendiente en el servidor"
}

Write-Host "==> Copiando scripts de despliegue..."
Stage-Dir (Join-Path $root 'deploy') 'deploy'
# el stage ya trae deploy/ completo; quitar el pbf de stage/osrm-data si vino de al lado
Remove-Item (Join-Path $stage 'deploy\osrm-data\guanajuato.osm.pbf') -ErrorAction SilentlyContinue

Write-Host "==> Comprimiendo..."
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip

$size = [Math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "LISTO: $zip ($size MB)"
Write-Host "Subir al servidor, descomprimir y seguir deploy/INSTALAR.txt"