# Downloads a portable toolchain for building the Android app into
# %LOCALAPPDATA%\cheesefork-tools (no installers, no admin rights, nothing
# added to the system PATH). Delete that folder to remove everything.
#
#   powershell -ExecutionPolicy Bypass -File native\scripts\setup-tools.ps1
#
# Installs: Node.js LTS, Eclipse Temurin JDK 21, Android command-line tools,
# platform-tools (adb), platform 35/36 and build-tools 35/36.

$ErrorActionPreference = 'Stop'

$NodeVersion = 'v24.22.1'
$CmdlineToolsBuild = '15859902'

$Tools = Join-Path $env:LOCALAPPDATA 'cheesefork-tools'
$Downloads = Join-Path $Tools 'downloads'
New-Item -ItemType Directory -Force $Downloads | Out-Null

function Get-File($Url, $Target) {
    if (Test-Path $Target) { return }
    Write-Host "Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Target -UseBasicParsing
}

function Expand-To($Zip, $Target) {
    Write-Host "Extracting $Zip"
    Expand-Archive -Path $Zip -DestinationPath $Target -Force
}

# Node.js
if (-not (Test-Path "$Tools\node\node.exe")) {
    $zip = "$Downloads\node.zip"
    Get-File "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip" $zip
    Expand-To $zip $Tools
    Rename-Item "$Tools\node-$NodeVersion-win-x64" 'node'
}

# JDK 21
if (-not (Test-Path "$Tools\jdk21\bin\java.exe")) {
    $zip = "$Downloads\jdk21.zip"
    Get-File 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk' $zip
    $tmp = "$Tools\jdk-tmp"
    Expand-To $zip $tmp
    $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
    Move-Item $inner.FullName "$Tools\jdk21"
    Remove-Item $tmp -Recurse -Force
}

# Android command-line tools
$Sdk = "$Tools\sdk"
if (-not (Test-Path "$Sdk\cmdline-tools\latest\bin\sdkmanager.bat")) {
    $zip = "$Downloads\cmdline-tools.zip"
    Get-File "https://dl.google.com/android/repository/commandlinetools-win-${CmdlineToolsBuild}_latest.zip" $zip
    New-Item -ItemType Directory -Force "$Sdk\cmdline-tools" | Out-Null
    Expand-To $zip "$Sdk\cmdline-tools"
    Rename-Item "$Sdk\cmdline-tools\cmdline-tools" 'latest'
}

$env:JAVA_HOME = "$Tools\jdk21"
$env:Path = "$Tools\jdk21\bin;$env:Path"
$sdkmanager = "$Sdk\cmdline-tools\latest\bin\sdkmanager.bat"

Write-Host 'Accepting Android SDK licenses'
$yes = 'y' * 20 -split '' | Where-Object { $_ } | ForEach-Object { $_ }
$yes | & $sdkmanager --sdk_root="$Sdk" --licenses | Out-Null

Write-Host 'Installing Android SDK packages'
& $sdkmanager --sdk_root="$Sdk" 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0' 'platforms;android-36' 'build-tools;36.0.0'

Write-Host ''
Write-Host "Toolchain ready in $Tools"
Write-Host 'Build the app with: powershell -ExecutionPolicy Bypass -File native\build-android.ps1'
