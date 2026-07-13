[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [Parameter(Mandatory = $true)]
  [string]$SpecPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

function Get-OptionalValue {
  param(
    [object]$Object,
    [string]$Name,
    [object]$DefaultValue
  )

  if ($null -eq $Object) {
    return $DefaultValue
  }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) {
    return $DefaultValue
  }
  return $property.Value
}

function Convert-HtmlColor {
  param([string]$Value)
  try {
    return [System.Drawing.ColorTranslator]::FromHtml($Value)
  } catch {
    throw "Invalid color value: $Value"
  }
}

function Convert-NormalizedCoordinate {
  param(
    [object]$Value,
    [int]$Maximum,
    [string]$Name
  )

  $number = [double]$Value
  if ($number -lt 0 -or $number -gt 1) {
    throw "$Name must be between 0 and 1; got $number."
  }
  return [single]($number * $Maximum)
}

function New-RoundedPath {
  param(
    [single]$X,
    [single]$Y,
    [single]$Width,
    [single]$Height,
    [single]$Radius
  )

  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = [single](2 * [Math]::Min($Radius, [Math]::Min($Width / 2, $Height / 2)))
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Get-ArrowStart {
  param(
    [single]$X,
    [single]$Y,
    [single]$Width,
    [single]$Height,
    [single]$TargetX,
    [single]$TargetY
  )

  $centerX = $X + $Width / 2
  $centerY = $Y + $Height / 2
  $deltaX = $TargetX - $centerX
  $deltaY = $TargetY - $centerY
  if ([Math]::Abs($deltaX) -lt 0.001 -and [Math]::Abs($deltaY) -lt 0.001) {
    return New-Object System.Drawing.PointF($centerX, $Y + $Height)
  }

  $halfWidth = $Width / 2
  $halfHeight = $Height / 2
  if ([Math]::Abs($deltaX) / $halfWidth -gt [Math]::Abs($deltaY) / $halfHeight) {
    $direction = if ($deltaX -ge 0) { 1 } else { -1 }
    $startX = $centerX + $direction * $halfWidth
    $startY = $centerY + $deltaY * ($halfWidth / [Math]::Abs($deltaX))
  } else {
    $direction = if ($deltaY -ge 0) { 1 } else { -1 }
    $startY = $centerY + $direction * $halfHeight
    $startX = $centerX + $deltaX * ($halfHeight / [Math]::Abs($deltaY))
  }
  return New-Object System.Drawing.PointF([single]$startX, [single]$startY)
}

function Draw-Arrow {
  param(
    [System.Drawing.Graphics]$Graphics,
    [System.Drawing.Color]$Color,
    [single]$StartX,
    [single]$StartY,
    [single]$TargetX,
    [single]$TargetY,
    [single]$LineWidth,
    [single]$TargetRadius,
    [single]$Scale
  )

  $deltaX = $TargetX - $StartX
  $deltaY = $TargetY - $StartY
  $length = [Math]::Sqrt($deltaX * $deltaX + $deltaY * $deltaY)
  if ($length -lt 5 * $Scale) {
    throw 'The label is too close to its target to draw an arrow.'
  }

  $unitX = $deltaX / $length
  $unitY = $deltaY / $length
  $perpendicularX = -$unitY
  $perpendicularY = $unitX
  $tipDistance = $TargetRadius + 3 * $Scale
  $arrowLength = 52 * $Scale
  $arrowHalfWidth = 25 * $Scale
  $tipX = $TargetX - $tipDistance * $unitX
  $tipY = $TargetY - $tipDistance * $unitY
  $baseX = $tipX - $arrowLength * $unitX
  $baseY = $tipY - $arrowLength * $unitY

  $pen = New-Object System.Drawing.Pen($Color, $LineWidth)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $brush = New-Object System.Drawing.SolidBrush($Color)
  $ringPen = New-Object System.Drawing.Pen($Color, [single]([Math]::Max(3, $LineWidth * 0.75)))
  try {
    $Graphics.DrawLine($pen, $StartX, $StartY, $baseX, $baseY)
    $points = [System.Drawing.PointF[]]@(
      (New-Object System.Drawing.PointF([single]$tipX, [single]$tipY)),
      (New-Object System.Drawing.PointF([single]($baseX + $arrowHalfWidth * $perpendicularX), [single]($baseY + $arrowHalfWidth * $perpendicularY))),
      (New-Object System.Drawing.PointF([single]($baseX - $arrowHalfWidth * $perpendicularX), [single]($baseY - $arrowHalfWidth * $perpendicularY)))
    )
    $Graphics.FillPolygon($brush, $points)
    $Graphics.DrawEllipse($ringPen, $TargetX - $TargetRadius, $TargetY - $TargetRadius, 2 * $TargetRadius, 2 * $TargetRadius)
  } finally {
    $ringPen.Dispose()
    $brush.Dispose()
    $pen.Dispose()
  }
}

function Draw-Label {
  param(
    [System.Drawing.Graphics]$Graphics,
    [string]$Text,
    [single]$X,
    [single]$Y,
    [single]$Width,
    [single]$Height,
    [System.Drawing.Color]$LabelColor,
    [System.Drawing.Color]$TextColor,
    [System.Drawing.Color]$ShadowColor,
    [string]$FontFamily,
    [single]$FontSize,
    [single]$CornerRadius,
    [single]$Scale
  )

  $shadowOffset = 9 * $Scale
  $shadowPath = New-RoundedPath -X ($X + $shadowOffset) -Y ($Y + $shadowOffset) -Width $Width -Height $Height -Radius $CornerRadius
  $labelPath = New-RoundedPath -X $X -Y $Y -Width $Width -Height $Height -Radius $CornerRadius
  $shadowBrush = New-Object System.Drawing.SolidBrush($ShadowColor)
  $labelBrush = New-Object System.Drawing.SolidBrush($LabelColor)
  $textBrush = New-Object System.Drawing.SolidBrush($TextColor)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $format.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter

  $font = $null
  try {
    $Graphics.FillPath($shadowBrush, $shadowPath)
    $Graphics.FillPath($labelBrush, $labelPath)

    $candidateSize = $FontSize
    do {
      if ($null -ne $font) {
        $font.Dispose()
      }
      $font = New-Object System.Drawing.Font($FontFamily, $candidateSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
      $measured = $Graphics.MeasureString($Text, $font, [int]($Width - 24 * $Scale), $format)
      $candidateSize -= 2 * $Scale
    } while (($measured.Width -gt $Width - 18 * $Scale -or $measured.Height -gt $Height - 12 * $Scale) -and $candidateSize -gt 22 * $Scale)

    $rectangle = New-Object System.Drawing.RectangleF($X, $Y, $Width, $Height)
    $Graphics.DrawString($Text, $font, $textBrush, $rectangle, $format)
  } finally {
    if ($null -ne $font) {
      $font.Dispose()
    }
    $format.Dispose()
    $textBrush.Dispose()
    $labelBrush.Dispose()
    $shadowBrush.Dispose()
    $labelPath.Dispose()
    $shadowPath.Dispose()
  }
}

$resolvedInput = (Resolve-Path -LiteralPath $InputPath -ErrorAction Stop).Path
$resolvedSpec = (Resolve-Path -LiteralPath $SpecPath -ErrorAction Stop).Path
$fullOutput = [IO.Path]::GetFullPath($OutputPath)
if ($resolvedInput -eq $fullOutput) {
  throw 'OutputPath must differ from InputPath so the original screenshot is preserved.'
}

$spec = Get-Content -LiteralPath $resolvedSpec -Encoding utf8 -Raw | ConvertFrom-Json
$annotations = @($spec.annotations)
if ($annotations.Count -lt 1 -or $annotations.Count -gt 5) {
  throw "Each screenshot must have 1 to 5 annotations; got $($annotations.Count)."
}

$source = [System.Drawing.Image]::FromFile($resolvedInput)
$bitmap = New-Object System.Drawing.Bitmap($source.Width, $source.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
if ($source.HorizontalResolution -gt 0 -and $source.VerticalResolution -gt 0) {
  $bitmap.SetResolution($source.HorizontalResolution, $source.VerticalResolution)
}
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

try {
  $destination = New-Object System.Drawing.Rectangle(0, 0, $source.Width, $source.Height)
  $graphics.DrawImage($source, $destination, 0, 0, $source.Width, $source.Height, [System.Drawing.GraphicsUnit]::Pixel)

  $style = Get-OptionalValue -Object $spec -Name 'style' -DefaultValue $null
  $labelColor = Convert-HtmlColor ([string](Get-OptionalValue $style 'label_color' '#FF4619'))
  $textColor = Convert-HtmlColor ([string](Get-OptionalValue $style 'text_color' '#FFFFFF'))
  $shadowColor = [System.Drawing.Color]::FromArgb(72, 0, 0, 0)
  $fontFamily = [string](Get-OptionalValue $style 'font_family' 'Microsoft YaHei')
  $scale = [single]($source.Height / 1750.0)
  $fontSize = [single]([double](Get-OptionalValue $style 'font_size' 40) * $scale)
  $lineWidth = [single]([double](Get-OptionalValue $style 'line_width' 9) * $scale)
  $targetRadius = [single]([double](Get-OptionalValue $style 'target_radius' 18) * $scale)
  $cornerRadius = [single]([double](Get-OptionalValue $style 'corner_radius' 18) * $scale)

  $prepared = @()
  foreach ($annotation in $annotations) {
    $text = [string]$annotation.text
    if ([string]::IsNullOrWhiteSpace($text)) {
      throw 'Annotation text cannot be empty.'
    }
    $label = $annotation.label
    $target = $annotation.target
    $x = Convert-NormalizedCoordinate $label.x $source.Width 'label.x'
    $y = Convert-NormalizedCoordinate $label.y $source.Height 'label.y'
    $width = Convert-NormalizedCoordinate $label.width $source.Width 'label.width'
    $height = Convert-NormalizedCoordinate $label.height $source.Height 'label.height'
    $targetX = Convert-NormalizedCoordinate $target.x $source.Width 'target.x'
    $targetY = Convert-NormalizedCoordinate $target.y $source.Height 'target.y'
    if ($width -lt 80 * $scale -or $height -lt 45 * $scale) {
      throw "The label rectangle is too small for annotation: $text"
    }
    if ($x + $width -gt $source.Width -or $y + $height -gt $source.Height) {
      throw "The label rectangle exceeds the image bounds for annotation: $text"
    }
    $start = Get-ArrowStart -X $x -Y $y -Width $width -Height $height -TargetX $targetX -TargetY $targetY
    $prepared += [pscustomobject]@{
      text = $text
      x = $x
      y = $y
      width = $width
      height = $height
      target_x = $targetX
      target_y = $targetY
      start_x = $start.X
      start_y = $start.Y
    }
  }

  foreach ($item in $prepared) {
    Draw-Arrow -Graphics $graphics -Color $labelColor -StartX $item.start_x -StartY $item.start_y -TargetX $item.target_x -TargetY $item.target_y -LineWidth $lineWidth -TargetRadius $targetRadius -Scale $scale
  }
  foreach ($item in $prepared) {
    Draw-Label -Graphics $graphics -Text $item.text -X $item.x -Y $item.y -Width $item.width -Height $item.height -LabelColor $labelColor -TextColor $textColor -ShadowColor $shadowColor -FontFamily $fontFamily -FontSize $fontSize -CornerRadius $cornerRadius -Scale $scale
  }

  $outputDirectory = [IO.Path]::GetDirectoryName($fullOutput)
  if (-not [string]::IsNullOrWhiteSpace($outputDirectory)) {
    [void](New-Item -ItemType Directory -Path $outputDirectory -Force)
  }
  $bitmap.Save($fullOutput, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
  $source.Dispose()
}

[pscustomobject]@{
  input_path = $resolvedInput
  output_path = $fullOutput
  width = $destination.Width
  height = $destination.Height
  annotations = $annotations.Count
}
