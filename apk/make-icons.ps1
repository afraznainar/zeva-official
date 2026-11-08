# Replaces Capacitor's default Android icons with the Zeva icon.
# Run after `npx cap add android`; rerun after a logo change.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root "deploy\dist\assets\img\icon-512.png"
$res  = Join-Path $root "apk\android\app\src\main\res"

$img = [System.Drawing.Image]::FromFile($src)
$ink = [System.Drawing.Color]::FromArgb(255, 14, 10, 8)

function New-Canvas([int]$w, [int]$h, [System.Drawing.Color]$bg) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear($bg)
  return @($bmp, $g)
}

# Launcher icons: 48dp at 1x, scaled per density.
$dens = @{ "mdpi" = 1.0; "hdpi" = 1.5; "xhdpi" = 2.0; "xxhdpi" = 3.0; "xxxhdpi" = 4.0 }
foreach ($k in $dens.Keys) {
  $f = $dens[$k]
  $size = [int](48 * $f)
  $out = Join-Path $res "mipmap-$k"

  $pair = New-Canvas $size $size $ink
  $pair[1].DrawImage($img, 0, 0, $size, $size)
  $pair[1].Dispose()
  $pair[0].Save((Join-Path $out "ic_launcher.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $pair[0].Save((Join-Path $out "ic_launcher_round.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $pair[0].Dispose()

  # Adaptive foreground sits on a 108dp canvas with a safe zone.
  $canvas = [int](108 * $f)
  $inner = [int]($canvas * 0.62)
  $off = [int](($canvas - $inner) / 2)
  $fg = New-Canvas $canvas $canvas ([System.Drawing.Color]::Transparent)
  $fg[1].DrawImage($img, $off, $off, $inner, $inner)
  $fg[1].Dispose()
  $fg[0].Save((Join-Path $out "ic_launcher_foreground.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $fg[0].Dispose()
}

# Splash screens: keep their size, paint the brand ink and centre the logo.
Get-ChildItem -Path $res -Recurse -Filter "splash.png" | ForEach-Object {
  $old = [System.Drawing.Image]::FromFile($_.FullName)
  $w = $old.Width; $h = $old.Height
  $old.Dispose()

  $pair = New-Canvas $w $h $ink
  $logo = [int]([Math]::Min($w, $h) * 0.32)
  $x = [int](($w - $logo) / 2)
  $y = [int](($h - $logo) / 2)
  $pair[1].DrawImage($img, $x, $y, $logo, $logo)
  $pair[1].Dispose()
  $pair[0].Save($_.FullName, [System.Drawing.Imaging.ImageFormat]::Png)
  $pair[0].Dispose()
}

# Adaptive-icon background colour.
$values = Join-Path $res "values\ic_launcher_background.xml"
if (Test-Path $values) {
  @'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#0E0A08</color>
</resources>
'@ | Set-Content -Path $values -Encoding UTF8
}

$img.Dispose()
Write-Host "Android icons and splash screens updated."
