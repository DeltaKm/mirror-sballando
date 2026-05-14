param(
    [string]$Environment = "Production",
    [string]$Url = "http://127.0.0.1:5177"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$apiProject = Join-Path $root "src\PrintBroker.Api\PrintBroker.Api.csproj"

function Resolve-DotNet {
    $cmd = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }

    $userDotnet = Join-Path $env:USERPROFILE ".dotnet\dotnet.exe"
    if (Test-Path $userDotnet) {
        return $userDotnet
    }

    throw "dotnet non trovato. Installa .NET 8 SDK."
}

$dotnet = Resolve-DotNet

$env:ASPNETCORE_ENVIRONMENT = $Environment
$env:PRINTBROKER_PrintBroker__ListenUrl = $Url

& $dotnet run --project $apiProject
