param(
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot

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
Push-Location $root
try {
    & $dotnet restore .\MirrorSballando.PrintBroker.sln
    & $dotnet build .\MirrorSballando.PrintBroker.sln -c $Configuration --no-restore
}
finally {
    Pop-Location
}
