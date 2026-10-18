param([string]$Directory = $(if ($env:DSH_BRIDGE_CONFIG_DIR) { $env:DSH_BRIDGE_CONFIG_DIR } else { Join-Path $env:LOCALAPPDATA 'DeepSeekHarnessBridge' }))
$ErrorActionPreference = 'Stop'
# A Windows PowerShell child can inherit PowerShell 7's incompatible PSModulePath.
# Import the security commands from this interpreter's own module directory.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
if ($env:OS -ne 'Windows_NT') { throw 'This helper requires Windows DPAPI.' }
$Directory = [IO.Path]::GetFullPath($Directory)
[IO.Directory]::CreateDirectory($Directory) | Out-Null
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $Directory -AclObject $acl
$secret = Read-Host 'Paste your DeepSeek API Key (hidden; never sent to chat)' -AsSecureString
if ($secret.Length -eq 0) { throw 'No key entered; existing credential was not changed.' }
$temporary = Join-Path $Directory ('key-' + [guid]::NewGuid().ToString() + '.tmp')
try {
  # Without -Key, Windows encrypts for the current user using DPAPI.
  $encrypted = ConvertFrom-SecureString -SecureString $secret
  [IO.File]::WriteAllText($temporary, $encrypted, [Text.Encoding]::ASCII)
  Move-Item -LiteralPath $temporary -Destination (Join-Path $Directory 'api-key.dpapi') -Force
  Write-Host 'Saved an encrypted credential for this Windows account. The key was not displayed.'
  Read-Host 'Saved successfully. Press Enter to close this window' | Out-Null
} finally {
  $secret.Dispose()
  $encrypted = $null
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
}
