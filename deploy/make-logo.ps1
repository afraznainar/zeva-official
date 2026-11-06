# Converts the restaurant logo (webp/png/jpg) into an ESC/POS raster blob.
# Output: assets/logo.bin  -> GS v 0 header + packed 1-bit rows, prepended to every bill.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File make-logo.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File make-logo.ps1 -Height 120 -Threshold 170
#
# Uses WIC (no extra software needed) so webp works, and composites transparency
# onto white so the logo never prints as a solid black block.
param(
  [string]$Source = "",
  [string]$Out = "",
  [int]$Height = 170,
  [int]$Threshold = 165
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Source) { $Source = Join-Path $here "dist\assets\img\zeva-mark.webp" }
if (-not $Out)    { $Out    = Join-Path $here "assets\logo.bin" }
if (-not (Test-Path -LiteralPath $Source)) { Write-Output "ERROR: missing $Source"; exit 1 }

try {
  $uri = New-Object System.Uri((Resolve-Path -LiteralPath $Source).Path)
  $decoder = [System.Windows.Media.Imaging.BitmapDecoder]::Create($uri, "None", "OnLoad")
  $frame = $decoder.Frames[0]

  $ratio = $frame.PixelWidth / $frame.PixelHeight
  $h = $Height
  $w = [int][Math]::Round($Height * $ratio)
  if ($w -lt 8) { $w = 8 }
  if ($w -gt 384) { $w = 384; $h = [int][Math]::Round($w / $ratio) }

  $scale = New-Object System.Windows.Media.ScaleTransform(($w / $frame.PixelWidth), ($h / $frame.PixelHeight))
  $scaled = New-Object System.Windows.Media.Imaging.TransformedBitmap($frame, $scale)
  $bgra = New-Object System.Windows.Media.Imaging.FormatConvertedBitmap(
    $scaled,
    ([System.Windows.Media.PixelFormats]::Bgra32),
    $null,
    0.0
  )

  $stride = $bgra.PixelWidth * 4
  $pixels = New-Object byte[] ($stride * $bgra.PixelHeight)
  $rect = New-Object System.Windows.Int32Rect(0, 0, $bgra.PixelWidth, $bgra.PixelHeight)
  $bgra.CopyPixels($rect, $pixels, $stride, 0)

  # Composite every pixel over white and remember its brightness.
  $lums = New-Object double[] ($bgra.PixelWidth * $bgra.PixelHeight)
  $dark = 0
  $total = $bgra.PixelWidth * $bgra.PixelHeight
  for ($y = 0; $y -lt $bgra.PixelHeight; $y++) {
    for ($x = 0; $x -lt $bgra.PixelWidth; $x++) {
      $i = ($y * $stride) + ($x * 4)
      $b = $pixels[$i]; $g = $pixels[$i + 1]; $r = $pixels[$i + 2]; $a = $pixels[$i + 3]
      if ($a -lt 255) {
        $r = [int](($r * $a + 255 * (255 - $a)) / 255)
        $g = [int](($g * $a + 255 * (255 - $a)) / 255)
        $b = [int](($b * $a + 255 * (255 - $a)) / 255)
      }
      $lum = (0.299 * $r) + (0.587 * $g) + (0.114 * $b)
      $lums[($y * $bgra.PixelWidth) + $x] = $lum
      if ($lum -lt 40) { $dark++ }
    }
  }

  # A logo drawn light-on-dark (like ours, gold on black) must be inverted for
  # thermal paper, otherwise the whole tile prints as a solid black block.
  $invert = ($dark / $total) -gt 0.5

  $bytesPerRow = [int][Math]::Ceiling($bgra.PixelWidth / 8.0)
  $data = New-Object byte[] ($bytesPerRow * $bgra.PixelHeight)
  $ink = 0
  for ($y = 0; $y -lt $bgra.PixelHeight; $y++) {
    for ($x = 0; $x -lt $bgra.PixelWidth; $x++) {
      $lum = $lums[($y * $bgra.PixelWidth) + $x]
      $isInk = if ($invert) { $lum -ge 40 } else { $lum -lt $Threshold }
      if ($isInk) {
        $idx = ($y * $bytesPerRow) + [int][Math]::Floor($x / 8)
        $data[$idx] = $data[$idx] -bor (0x80 -shr ($x % 8))
        $ink++
      }
    }
  }
  Write-Output ("source is " + $(if ($invert) { 'light-on-dark -> inverted for paper' } else { 'dark-on-light' }))

  $header = [byte[]](0x1D, 0x76, 0x30, 0x00,
    [byte]($bytesPerRow % 256), [byte]([Math]::Floor($bytesPerRow / 256)),
    [byte]($bgra.PixelHeight % 256), [byte]([Math]::Floor($bgra.PixelHeight / 256)))

  $all = New-Object byte[] ($header.Length + $data.Length)
  [Array]::Copy($header, 0, $all, 0, $header.Length)
  [Array]::Copy($data, 0, $all, $header.Length, $data.Length)
  [System.IO.File]::WriteAllBytes($Out, $all)

  $pct = [Math]::Round(100.0 * $ink / ($bgra.PixelWidth * $bgra.PixelHeight), 1)
  Write-Output ("OK {0}x{1} dots, {2} bytes, ink {3}% -> {4}" -f $bgra.PixelWidth, $bgra.PixelHeight, $all.Length, $pct, $Out)
  if ($pct -gt 80) { Write-Output "WARNING: ink coverage is very high - raise -Threshold or check the source image" }
}
catch {
  Write-Output ("FAILED: " + $_.Exception.Message)
  exit 1
}
