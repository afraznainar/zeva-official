# Builds the favicon set from the brand mark.
#   deploy/dist/favicon.ico                      16 + 32 + 48, transparent
#   deploy/dist/assets/img/favicon-{16,32,48}.png  transparent
#   deploy/dist/assets/img/apple-touch-icon.png    180, ink background
#
# The mark is gold calligraphy on black. Alpha comes from luminance and the
# colour is a flat brass, so the icon reads on light and dark tab bars.
param(
  [string]$Source = "$PSScriptRoot\dist\assets\img\zeva-mark.webp",
  [string]$OutDir = "$PSScriptRoot\dist",
  [string]$Brass  = "C08536",
  [string]$Ink    = "0E0A08"
)

Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Drawing

$uri = New-Object System.Uri($Source)
$decoder = [System.Windows.Media.Imaging.BitmapDecoder]::Create($uri, 'None', 'OnLoad')
$converted = New-Object System.Windows.Media.Imaging.FormatConvertedBitmap($decoder.Frames[0], ([System.Windows.Media.PixelFormats]::Bgra32), $null, 0.0)

$w = $converted.PixelWidth
$h = $converted.PixelHeight
$stride = $w * 4
$pixels = New-Object byte[] ($stride * $h)
$converted.CopyPixels((New-Object System.Windows.Int32Rect(0, 0, $w, $h)), $pixels, $stride, 0)

# alpha map and content bounds
$alpha = New-Object byte[] ($w * $h)
$minX = $w; $minY = $h; $maxX = -1; $maxY = -1
for ($y = 0; $y -lt $h; $y++) {
  for ($x = 0; $x -lt $w; $x++) {
    $i = ($y * $stride) + ($x * 4)
    $lum = 0.299 * $pixels[$i + 2] + 0.587 * $pixels[$i + 1] + 0.114 * $pixels[$i]
    if ($lum -gt 26) {
      $a = [int][Math]::Min(255, [Math]::Round(($lum - 18) * 1.9))
      if ($a -lt 8) { $a = 8 }
      $alpha[($y * $w) + $x] = [byte]$a
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
if ($maxX -lt 0) { throw "no mark found in $Source" }

$cw = $maxX - $minX + 1
$ch = $maxY - $minY + 1
Write-Output "mark bounds ${cw}x${ch} at $minX,$minY"

# the cropped mark, flat brass with the source's alpha
$mask = New-Object System.Drawing.Bitmap($cw, $ch, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$brassColor = [System.Drawing.ColorTranslator]::FromHtml("#" + $Brass)
for ($y = 0; $y -lt $ch; $y++) {
  for ($x = 0; $x -lt $cw; $x++) {
    $a = $alpha[(($y + $minY) * $w) + ($x + $minX)]
    if ($a -gt 0) { $mask.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($a, $brassColor)) }
  }
}

function New-Icon([int]$size, [bool]$opaque, [double]$pad) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $bg = [System.Drawing.Color]::Transparent
  if ($opaque) { $bg = [System.Drawing.ColorTranslator]::FromHtml("#" + $Ink) }
  $g.Clear($bg)

  $inner = $size * (1 - 2 * $pad)
  $scale = [Math]::Min($inner / $cw, $inner / $ch)
  $dw = [Math]::Max(1, [int][Math]::Round($cw * $scale))
  $dh = [Math]::Max(1, [int][Math]::Round($ch * $scale))
  $dx = [int][Math]::Round(($size - $dw) / 2)
  $dy = [int][Math]::Round(($size - $dh) / 2)

  $dst = New-Object System.Drawing.Rectangle($dx, $dy, $dw, $dh)
  $g.DrawImage($mask, $dst)
  $g.Dispose()
  return $bmp
}

$imgDir = Join-Path $OutDir "assets\img"
New-Item -ItemType Directory -Force -Path $imgDir | Out-Null

$sizes = @(16, 32, 48)
$pngs = @{}
foreach ($s in $sizes) {
  # small icons get less padding so the strokes stay as thick as possible
  $pad = 0.06
  if ($s -le 16) { $pad = 0.02 } elseif ($s -le 32) { $pad = 0.04 }
  $bmp = New-Icon $s $false $pad
  $file = Join-Path $imgDir ("favicon-" + $s + ".png")
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $pngs[$s] = [System.IO.File]::ReadAllBytes($file)
  Write-Output ("wrote " + $file + " (" + (Get-Item $file).Length + " bytes)")
}

$apple = New-Icon 180 $true 0.14
$applePath = Join-Path $imgDir "apple-touch-icon.png"
$apple.Save($applePath, [System.Drawing.Imaging.ImageFormat]::Png)
$apple.Dispose()

# PWA icons for the installable app (manifest.webmanifest).
# The maskable variant keeps the mark inside the 80% safe circle so Android
# can crop it to its own shape without clipping the calligraphy.
$appIcons = @(
  @{ size = 192; name = 'icon-192.png'; pad = 0.13 },
  @{ size = 512; name = 'icon-512.png'; pad = 0.13 },
  @{ size = 512; name = 'icon-maskable-512.png'; pad = 0.22 }
)
foreach ($spec in $appIcons) {
  $bmp = New-Icon $spec.size $true $spec.pad
  $file = Join-Path $imgDir $spec.name
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("wrote " + $file + " (" + (Get-Item $file).Length + " bytes)")
}

$mask.Dispose()
Write-Output ("wrote " + $applePath + " (" + (Get-Item $applePath).Length + " bytes)")

# ICO container with PNG payloads
$count = $sizes.Count
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$count)
$offset = 6 + (16 * $count)
foreach ($s in $sizes) {
  $data = $pngs[$s]
  $dim = [byte]$s
  $bw.Write($dim); $bw.Write($dim)
  $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$data.Length); $bw.Write([UInt32]$offset)
  $offset += $data.Length
}
foreach ($s in $sizes) { $bw.Write($pngs[$s]) }
$bw.Flush()
$icoPath = Join-Path $OutDir "favicon.ico"
[System.IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
$bw.Dispose(); $ms.Dispose()
Write-Output ("wrote " + $icoPath + " (" + (Get-Item $icoPath).Length + " bytes, " + $count + " sizes)")
