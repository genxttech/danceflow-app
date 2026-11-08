# Shared interactive-entry helpers for the TW-4 launchers (run-stage-a.ps1, run-stage-b.ps1). Dot-source this file; do not run it.
#
# Hidden/visible line reader built on [Console]::ReadKey: Read-Host -AsSecureString stores a Ctrl+V key press as ONE literal control
# character in Windows PowerShell 5.1 (the "1 asterisk / 1 character" failure). Requirements from the dot-sourcing script:
#   $UseDryRunDefaults  (bool)   - true only for the non-interactive self-test (-DryRun without -Interactive)
#   Get-TestInput       (function) - the dry-run-only test seam
#   $script:ClipboardTextUsed    - initialised to $null by the script
# Nothing here writes credentials anywhere; the clipboard is cleared afterwards only if it still holds the secret that was read from it.

function Convert-SecureToPlain([System.Security.SecureString]$Secure) {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# Normalises text that came from a paste or the clipboard: drops bracketed-paste markers, control characters and surrounding spaces.
function Clean-Pasted([string]$Text) {
  if ($null -eq $Text) { return "" }
  $t = $Text -replace '\x1b?\[20[01]~', ''
  $t = $t -replace '[\x00-\x1f\x7f]', ''
  return $t.Trim()
}

function Get-ClipboardTextSafe {
  try {
    $raw = Get-Clipboard -Raw
    if ($null -eq $raw) { return "" }
    return Clean-Pasted ([string]$raw)
  }
  catch { return "" }
}

<#
  Hidden/visible line reader built on [Console]::ReadKey, because Read-Host -AsSecureString stores a Ctrl+V key press as one literal
  control character (0x16): the reported "1 asterisk / 1 character" failure. Handles:
    printable characters (typed or a pasted burst)   -> appended
    Ctrl+V, Shift+Insert                              -> the clipboard text is appended
    Enter on an empty secret                          -> the clipboard text is used
    Backspace                                         -> removes the last character
    ESC [ 2 0 0 ~ ... ESC [ 2 0 1 ~ (bracketed paste) -> markers swallowed
    Esc alone                                         -> cancels
  Returns the entered string, or $null if cancelled.
#>
function Read-LineInput {
  param([string]$Prompt, [switch]$Hidden, [switch]$ClipboardOnEmptyEnter, [switch]$TrackClipboard)
  $inputRedirected = $false
  try { $inputRedirected = [Console]::IsInputRedirected } catch { $inputRedirected = $true }
  if ($inputRedirected) {
    # no console keyboard (input piped or closed): fall back to the standard prompts
    if ($Hidden) {
      $secure = Read-Host $Prompt -AsSecureString
      if ($null -eq $secure) { return "" }
      return Convert-SecureToPlain $secure
    }
    $line = Read-Host $Prompt
    if ($null -eq $line) { return "" }
    return [string]$line
  }
  Write-Host -NoNewline "${Prompt}: "
  $buffer = New-Object System.Text.StringBuilder
  $cancelled = $false
  try {
    while ($true) {
      $key = [Console]::ReadKey($true)
      $ch = $key.KeyChar
      $isCtrlV = ([int]$ch -eq 22) -or (($key.Key -eq [ConsoleKey]::V) -and (($key.Modifiers -band [ConsoleModifiers]::Control) -ne 0))
      $isShiftInsert = ($key.Key -eq [ConsoleKey]::Insert) -and (($key.Modifiers -band [ConsoleModifiers]::Shift) -ne 0)
      if ($key.Key -eq [ConsoleKey]::Enter) { break }
      elseif ($key.Key -eq [ConsoleKey]::Escape) {
        if ([Console]::KeyAvailable) {
          # the start of an escape sequence (bracketed paste markers, for example): swallow it up to its '~'
          $guard = 0
          while ([Console]::KeyAvailable -and $guard -lt 12) { $next = [Console]::ReadKey($true); $guard++; if ($next.KeyChar -eq [char]'~') { break } }
        }
        else { $cancelled = $true; break }
      }
      elseif ($key.Key -eq [ConsoleKey]::Backspace) {
        if ($buffer.Length -gt 0) { [void]$buffer.Remove($buffer.Length - 1, 1); Write-Host -NoNewline "`b `b" }
      }
      elseif ($isCtrlV -or $isShiftInsert) {
        $clip = Get-ClipboardTextSafe
        if ($clip.Length -gt 0) {
          [void]$buffer.Append($clip)
          if ($TrackClipboard) { $script:ClipboardTextUsed = $clip }
          Write-Host -NoNewline $(if ($Hidden) { "*" * $clip.Length } else { $clip })
        }
      }
      elseif (-not [char]::IsControl($ch)) {
        [void]$buffer.Append($ch)
        Write-Host -NoNewline $(if ($Hidden) { "*" } else { [string]$ch })
      }
    }
    if (-not $cancelled -and $buffer.Length -eq 0 -and $ClipboardOnEmptyEnter) {
      $clip = Get-ClipboardTextSafe
      if ($clip.Length -gt 0) {
        [void]$buffer.Append($clip)
        if ($TrackClipboard) { $script:ClipboardTextUsed = $clip }
        Write-Host -NoNewline $(if ($Hidden) { "(read from the clipboard) " + ("*" * $clip.Length) } else { $clip })
      }
    }
    Write-Host ""
    if ($cancelled) { return $null }
    return (Clean-Pasted $buffer.ToString())
  }
  finally {
    [void]$buffer.Clear()
  }
}

function Clear-ClipboardIfItHolds([string]$Secret) {
  if ([string]::IsNullOrEmpty($script:ClipboardTextUsed) -or [string]::IsNullOrEmpty($Secret)) { return }
  try {
    if ((Get-ClipboardTextSafe) -eq $Secret) {
      Set-Clipboard -Value $null
      Write-Host "  Clipboard cleared."
    }
  }
  catch { Write-Host "  (Could not clear the clipboard automatically; clear it yourself, and Windows clipboard history (Win+V) if it is on.)" }
}

function Read-Validated {
  param([string]$Prompt, [string]$TestVar, [scriptblock]$Check, [string]$DryDefault, [switch]$Secret, [switch]$NoClipboardTrack)
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $supplied = Get-TestInput $TestVar
    if (($null -eq $supplied -or $supplied -eq "") -and $UseDryRunDefaults -and $DryDefault) { $supplied = $DryDefault }
    if ($null -ne $supplied -and $supplied -ne "") { $raw = $supplied }
    elseif ($Secret) { $raw = Read-LineInput -Prompt "$Prompt - paste (Ctrl+V / right-click) or press Enter to read it from the clipboard" -Hidden -ClipboardOnEmptyEnter -TrackClipboard:(-not $NoClipboardTrack) }
    else { $raw = Read-LineInput -Prompt $Prompt }
    if ($null -eq $raw) { throw "Cancelled by you (Esc); nothing was sent." }
    $value = ([string]$raw).Trim()
    $note = if ($value -ne [string]$raw) { " (surrounding spaces were removed)" } else { "" }
    $problem = & $Check $value
    if (-not $problem) {
      if ($Secret -and -not $supplied) { Write-Host "  OK: $($value.Length) characters received$note" }
      elseif ($note) { Write-Host "  OK$note" }
      return $value
    }
    Write-Host "  Not accepted: $problem" -ForegroundColor Yellow
    if ($null -ne $supplied -and $supplied -ne "") { break } # a supplied test value does not get a second chance
  }
  throw "REFUSED (exit code 2), nothing was sent to Twilio. The $Prompt entry was not valid after 3 tries; run the launcher again."
}

function Test-Sid([string]$Value, [string]$Prefix, [string]$Label) {
  if ($Value.Length -eq 0) { return "$Label is empty." }
  if ($Value -notmatch '^[A-Za-z]{2}') { return "$Label does not start with letters; it must start with $Prefix." }
  $start = $Value.Substring(0, 2).ToUpper()
  if ($start -ne $Prefix) {
    if ($start -eq "AC" -and $Prefix -eq "SK") { return "that looks like an Account SID (AC...). The API key SID starts with SK." }
    if ($start -eq "SK" -and $Prefix -eq "AC") { return "that looks like an API key SID (SK...). The Account SID starts with AC." }
    return "$Label starts with '$start' but must start with $Prefix."
  }
  if ($Value.Length -ne 34) { return "$Label has $($Value.Length) characters; it must have 34 ($Prefix plus 32 hex characters)." }
  if ($Value -notmatch "^$Prefix[0-9a-fA-F]{32}$") { return "$Label contains characters other than 0-9 a-f after $Prefix." }
  return $null
}

