param(
    [string]$BaseUrl = "http://127.0.0.1:5177"
)

$ErrorActionPreference = "Stop"

function Get-BrokerDataDirectory {
    if ($env:PRINTBROKER_PrintBroker__BaseDataDirectory) {
        return $env:PRINTBROKER_PrintBroker__BaseDataDirectory
    }

    return Join-Path $env:LOCALAPPDATA "MirrorSballando\PrintBroker"
}

function Get-BrokerToken {
    if ($env:PRINT_BROKER_TOKEN) {
        return $env:PRINT_BROKER_TOKEN
    }

    $tokenPath = Join-Path (Get-BrokerDataDirectory) "broker.token"
    if (-not (Test-Path $tokenPath)) {
        throw "Token file non trovato: $tokenPath"
    }

    return (Get-Content -Path $tokenPath -Raw).Trim()
}

function Invoke-Broker {
    param(
        [string]$Method,
        [string]$Path,
        [hashtable]$Headers,
        [object]$Body
    )

    $uri = "$BaseUrl$Path"
    if ($Body -ne $null) {
        return Invoke-RestMethod -Method $Method -Uri $uri -Headers $Headers -Body ($Body | ConvertTo-Json -Depth 10) -ContentType "application/json"
    }

    return Invoke-RestMethod -Method $Method -Uri $uri -Headers $Headers
}

$token = Get-BrokerToken
$headers = @{ "X-Local-Token" = $token }

Write-Output "[1/6] GET /health"
$health = Invoke-Broker -Method "GET" -Path "/health" -Headers $headers -Body $null
$health | ConvertTo-Json -Depth 5

Write-Output "[2/6] GET /printers"
$printers = Invoke-Broker -Method "GET" -Path "/printers" -Headers $headers -Body $null
$printers | ConvertTo-Json -Depth 5

$firstPrinter = $null
if ($printers -is [System.Array] -and $printers.Count -gt 0) {
    $firstPrinter = $printers[0].name
} elseif ($printers.name) {
    $firstPrinter = $printers.name
}

if (-not $firstPrinter) {
    Write-Output "Nessuna stampante trovata. Skip test job endpoints."
    exit 0
}

$tempImage = Join-Path $env:TEMP "printbroker-smoke.jpg"
$base64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBUQEBAVFRUVFRUVFRUVFRUVFRUVFRUWFhUVFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OFQ8PFS0dFR0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAgMBIgACEQEDEQH/xAAXAAEBAQEAAAAAAAAAAAAAAAABAgME/8QAFhEBAQEAAAAAAAAAAAAAAAAAABEB/9oADAMBAAIQAxAAAAG6A//EABsQAAICAwEAAAAAAAAAAAAAAAABAhEDIRIx/9oACAEBAAEFAvXK0M0hX//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8BP//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8BP//EABoQAAICAwAAAAAAAAAAAAAAAAABAhEhMWH/2gAIAQEABj8ClfRrP//Z"
[IO.File]::WriteAllBytes($tempImage, [Convert]::FromBase64String($base64))

Write-Output "[3/6] POST /jobs"
$jobBody = @{
    imagePath = $tempImage
    printerName = $firstPrinter
    copies = 1
    paperSize = "Paper10x15"
    orientation = "Portrait"
    metadata = @{ source = "smoke-test" }
}
$created = Invoke-Broker -Method "POST" -Path "/jobs" -Headers $headers -Body $jobBody
$created | ConvertTo-Json -Depth 5

$jobId = $created.id
if (-not $jobId) {
    throw "Job ID non restituito"
}

Write-Output "[4/6] GET /jobs/$jobId"
$job = Invoke-Broker -Method "GET" -Path "/jobs/$jobId" -Headers $headers -Body $null
$job | ConvertTo-Json -Depth 5

Write-Output "[5/6] POST /jobs/$jobId/cancel"
$cancel = Invoke-Broker -Method "POST" -Path "/jobs/$jobId/cancel" -Headers $headers -Body @{}
$cancel | ConvertTo-Json -Depth 5

Write-Output "[6/6] GET /jobs?status=Canceled"
$canceled = Invoke-Broker -Method "GET" -Path "/jobs?status=Canceled" -Headers $headers -Body $null
$canceled | ConvertTo-Json -Depth 5

Write-Output "Smoke test completato"
