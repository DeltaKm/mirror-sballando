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
    & $dotnet test .\tests\PrintBroker.Tests\PrintBroker.Tests.csproj -c Release
}
finally {
    Pop-Location
}
