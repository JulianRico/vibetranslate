# generate-audio.ps1 - Genera los WAV de prueba (16 kHz mono) con las voces de Windows
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here 'audio'
New-Item -ItemType Directory -Force $out | Out-Null

Add-Type -AssemblyName System.Speech
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)

$voices = @{ es = 'Microsoft Sabina Desktop'; en = 'Microsoft Zira Desktop' }
$phrases = Get-Content -Raw -Encoding UTF8 (Join-Path $here 'phrases.json') | ConvertFrom-Json

foreach ($lang in 'es', 'en') {
  # Las frases con modismos son las que distinguen al traductor local de la nube
  foreach ($p in @($phrases.$lang) + @($phrases.idioms.$lang) + @($phrases.shortStart.$lang)) {
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $synth.SelectVoice($voices[$lang])
    $synth.SetOutputToWaveFile((Join-Path $out "$($p.id).wav"), $format)
    $synth.Speak($p.text)
    $synth.Dispose()
    Write-Output "$($p.id).wav"
  }
}
