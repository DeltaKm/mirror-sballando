param(
  [string]$ImagePath = '',
  [Parameter(Mandatory=$true)][string]$PrinterName,
  [double]$OffsetXmm = 0.0,
  [double]$OffsetYmm = 0.0,
  [double]$ZoomPct = 100.0,
  [switch]$TestPattern
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not $TestPattern) {
  if (-not $ImagePath -or -not (Test-Path -LiteralPath $ImagePath)) {
    Write-Error "Image not found: $ImagePath"
    exit 2
  }
  $img = [System.Drawing.Image]::FromFile($ImagePath)
} else {
  $img = $null
}
$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.PrinterSettings.PrinterName = $PrinterName
$doc.DocumentName = if ($TestPattern) { 'CalibrazioneTest' } else { [System.IO.Path]::GetFileName($ImagePath) }
$doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController

if (-not $doc.PrinterSettings.IsValid) {
  Write-Error "Printer not valid: $PrinterName"
  exit 3
}

# Seleziona carta 10x15 / 4x6 / Postcard / Selphy KP-108.
# IMPORTANTE: preferiamo la variante "borderless / senza bordi" quando il
# driver Canon SELPHY la espone (es. "Postcard Borderless", "Cartolina senza
# bordo", ...) cosi' la stampa va davvero a filo lato sinistro/destro.
$paperSizes = @($doc.PrinterSettings.PaperSizes)
$candidates = @()
foreach ($ps in $paperSizes) {
  $n = [string]$ps.PaperName
  if ($n -match '10\s*x\s*15' -or $n -match '4\s*x\s*6' -or $n -match 'Postcard' -or $n -match 'Cartolina' -or $n -match 'KP-?108' -or $n -match 'Selphy') {
    $candidates += ,$ps
  }
}
$selected = $null
foreach ($ps in $candidates) {
  $n = [string]$ps.PaperName
  if ($n -match '(?i)border\s*less' -or $n -match '(?i)senza\s*bordo' -or $n -match '(?i)no\s*border' -or $n -match '(?i)\bsb\b' -or $n -match '(?i)full\s*bleed') {
    $selected = $ps; break
  }
}
if (-not $selected -and $candidates.Count -gt 0) { $selected = $candidates[0] }
if (-not $selected) {
  # fallback: cerca dimensioni ~ 4x6 (in centesimi di pollice)
  foreach ($ps in $paperSizes) {
    $w = [int]$ps.Width; $h = [int]$ps.Height
    if (($w -eq 400 -and $h -eq 600) -or ($w -eq 600 -and $h -eq 400) -or ($w -eq 394 -and $h -eq 583) -or ($w -eq 583 -and $h -eq 394)) {
      $selected = $ps; break
    }
  }
}
if ($selected) {
  $doc.DefaultPageSettings.PaperSize = $selected
  Write-Host "[ms-direct-print] paper=$($selected.PaperName) ($($selected.Width)x$($selected.Height))"
} else {
  Write-Host "[ms-direct-print] paper=DEFAULT (10x15 non trovata, uso default driver)"
}

# Margini zero per stampa borderless
$doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
$doc.OriginAtMargins = $false

# Orientation: portrait se immagine più alta che larga (test pattern: portrait)
if ($TestPattern) {
  $doc.DefaultPageSettings.Landscape = $false
} else {
  $doc.DefaultPageSettings.Landscape = ($img.Width -gt $img.Height)
}

$script:imageRef = $img
$script:offsetXmm = [double]$OffsetXmm
$script:offsetYmm = [double]$OffsetYmm
$script:zoomPct = [double]$ZoomPct
$script:isTest = [bool]$TestPattern
$doc.add_PrintPage({
  param($senderObj, $e)
  try {
    $g = $e.Graphics
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode    = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode  = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    # Modalita' richiesta: full-bleed su PageBounds + calibrazione
    # (offset Y in mm e zoom % dal centro). PageUnit default = 1/100 inch.
    # Per ottenere il VERO full-bleed bisogna spostare l'origine grafica
    # al bordo fisico del foglio (PageBounds.X / Y sono negativi quando
    # il driver ha margini hardware) e allargare il clip a tutto il foglio.
    $hmX = [double]$e.PageSettings.HardMarginX
    $hmY = [double]$e.PageSettings.HardMarginY
    $g.TranslateTransform([single](-$hmX), [single](-$hmY))
    $paperW = [double]$e.PageBounds.Width
    $paperH = [double]$e.PageBounds.Height
    # $page rappresenta ora il foglio intero a partire da (0,0)
    $page = New-Object System.Drawing.Rectangle(0, 0, [int]$paperW, [int]$paperH)
    $g.SetClip([System.Drawing.RectangleF]::new(0, 0, [single]$paperW, [single]$paperH))
    Write-Host "[ms-direct-print] hardMargin=($hmX,$hmY) printable=$($e.PageSettings.PrintableArea) paper=$($paperW)x$($paperH)"
    # 1 mm = 100/25.4 unita' (centesimi di pollice)
    $mmToU = 100.0 / 25.4
    $offX = $script:offsetXmm * $mmToU
    $offY = $script:offsetYmm * $mmToU
    $zoom = $script:zoomPct / 100.0
    if ($zoom -lt 0.5) { $zoom = 0.5 }
    if ($zoom -gt 2.0) { $zoom = 2.0 }

    $g.FillRectangle([System.Drawing.Brushes]::White, $page)

    if ($script:isTest) {
      # Calibration test pattern: cornice, croce centrale, righelli mm
      $cx = [double]$page.X + [double]$page.Width / 2.0 + $offX
      $cy = [double]$page.Y + [double]$page.Height / 2.0 + $offY
      $bw = [double]$page.Width * $zoom
      $bh = [double]$page.Height * $zoom
      $bx = $cx - $bw / 2.0
      $by = $cy - $bh / 2.0
      $penBlack = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, 2)
      $penRed = New-Object System.Drawing.Pen([System.Drawing.Color]::Red, 2)
      # Cornice esterna (area di stampa simulata)
      $g.DrawRectangle($penBlack, [int]$bx, [int]$by, [int]$bw, [int]$bh)
      # Cornice 5mm interna (margine di taglio Selphy nominale)
      $pad = 5.0 * $mmToU
      $g.DrawRectangle($penRed, [int]($bx + $pad), [int]($by + $pad), [int]($bw - 2*$pad), [int]($bh - 2*$pad))
      # Croce centrale
      $crossLen = 10.0 * $mmToU
      $g.DrawLine($penBlack, [int]($cx - $crossLen), [int]$cy, [int]($cx + $crossLen), [int]$cy)
      $g.DrawLine($penBlack, [int]$cx, [int]($cy - $crossLen), [int]$cx, [int]($cy + $crossLen))
      # Righelli mm sui bordi (tick ogni 5 mm, lungo 3 mm)
      $tick = 3.0 * $mmToU
      for ($mm = 0; $mm -le [int]([double]$page.Width / $mmToU); $mm += 5) {
        $x = [double]$page.X + $mm * $mmToU
        $g.DrawLine($penBlack, [int]$x, [int]$page.Y, [int]$x, [int]([double]$page.Y + $tick))
        $g.DrawLine($penBlack, [int]$x, [int]([double]$page.Y + [double]$page.Height - $tick), [int]$x, [int]([double]$page.Y + [double]$page.Height))
      }
      for ($mm = 0; $mm -le [int]([double]$page.Height / $mmToU); $mm += 5) {
        $y = [double]$page.Y + $mm * $mmToU
        $g.DrawLine($penBlack, [int]$page.X, [int]$y, [int]([double]$page.X + $tick), [int]$y)
        $g.DrawLine($penBlack, [int]([double]$page.X + [double]$page.Width - $tick), [int]$y, [int]([double]$page.X + [double]$page.Width), [int]$y)
      }
      # Etichetta
      $font = New-Object System.Drawing.Font('Arial', 10)
      $label = "CALIBRAZIONE  offsetX=$($script:offsetXmm)mm  offsetY=$($script:offsetYmm)mm  zoom=$($script:zoomPct)%"
      $g.DrawString($label, $font, [System.Drawing.Brushes]::Black, [single]([double]$page.X + $pad), [single]([double]$page.Y + $pad))
      $font.Dispose()
      $penBlack.Dispose(); $penRed.Dispose()
      Write-Host "[ms-direct-print] mode=test-pattern page=$($page.Width)x$($page.Height) offset=($($script:offsetXmm),$($script:offsetYmm))mm zoom=$($script:zoomPct)%"
    } else {
      $iw = [double]$script:imageRef.Width
      $ih = [double]$script:imageRef.Height
      if ($iw -le 0 -or $ih -le 0) {
        $g.DrawImage($script:imageRef, $page)
      } else {
        # Cover sulla pagina (riempi fino al taglio) con zoom proporzionale
        # + offset centrato. La proporzione della foto resta sempre la stessa.
        $aw = [double]$page.Width * $zoom
        $ah = [double]$page.Height * $zoom
        $cx = [double]$page.X + [double]$page.Width / 2.0 + $offX
        $cy = [double]$page.Y + [double]$page.Height / 2.0 + $offY
        $ax = $cx - $aw / 2.0
        $ay = $cy - $ah / 2.0
        $imgRatio = $iw / $ih
        $areaRatio = $aw / $ah
        $srcX = 0.0; $srcY = 0.0; $srcW = $iw; $srcH = $ih
        if ($imgRatio -gt $areaRatio) {
          $srcW = $ih * $areaRatio
          $srcX = ($iw - $srcW) / 2.0
        } elseif ($imgRatio -lt $areaRatio) {
          $srcH = $iw / $areaRatio
          $srcY = ($ih - $srcH) / 2.0
        }
        $destRect = New-Object System.Drawing.Rectangle([int][Math]::Round($ax), [int][Math]::Round($ay), [int][Math]::Round($aw), [int][Math]::Round($ah))
        $srcRect  = New-Object System.Drawing.Rectangle([int][Math]::Round($srcX), [int][Math]::Round($srcY), [int][Math]::Round($srcW), [int][Math]::Round($srcH))
        $g.DrawImage($script:imageRef, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
        Write-Host "[ms-direct-print] mode=full-bleed offset=($($script:offsetXmm),$($script:offsetYmm))mm zoom=$($script:zoomPct)% page=$($page.Width)x$($page.Height) dest=$($destRect.Width)x$($destRect.Height)@($($destRect.X),$($destRect.Y))"
      }
    }
    $e.HasMorePages = $false
  } catch {
    Write-Error $_
  }
})

try {
  $doc.Print()
  Write-Host "[ms-direct-print] OK"
  exit 0
} catch {
  Write-Error $_
  exit 4
} finally {
  if ($img) { $img.Dispose() }
  if ($doc) { $doc.Dispose() }
}
