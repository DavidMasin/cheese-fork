# Builds the CheeseFork Android APK.
#
#   powershell -ExecutionPolicy Bypass -File native\build-android.ps1 [-Debug] [-Install] [-SkipSync]
#
# - Uses the portable toolchain from scripts\setup-tools.ps1 (downloaded on
#   first run if missing).
# - Creates a release signing key on first run in
#   %LOCALAPPDATA%\cheesefork-tools\keystore (keep it! Updates must be signed
#   with the same key, otherwise Android asks to uninstall the app first).
# - Output: native\dist\CheeseFork-release.apk (or CheeseFork-debug.apk).
# - -Install installs the APK on a phone connected with USB debugging (adb).

param(
    [switch]$Debug,
    [switch]$Install,
    [switch]$SkipSync
)

$ErrorActionPreference = 'Stop'

$Native = $PSScriptRoot
$Tools = Join-Path $env:LOCALAPPDATA 'cheesefork-tools'

if (-not (Test-Path "$Tools\node\node.exe") -or -not (Test-Path "$Tools\jdk21\bin\java.exe") -or -not (Test-Path "$Tools\sdk\platforms")) {
    & "$Native\scripts\setup-tools.ps1"
}

$env:JAVA_HOME = "$Tools\jdk21"
$env:ANDROID_HOME = "$Tools\sdk"
$env:ANDROID_SDK_ROOT = "$Tools\sdk"
$env:Path = "$Tools\node;$Tools\jdk21\bin;$Tools\sdk\platform-tools;$env:Path"

Push-Location $Native
try {
    if (-not (Test-Path 'node_modules')) {
        Write-Host '== npm install'
        & npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
    }

    if (-not $SkipSync) {
        Write-Host '== Assembling www and syncing the Android project'
        & npm run build:www
        if ($LASTEXITCODE -ne 0) { throw 'build:www failed' }
        & npx cap sync android
        if ($LASTEXITCODE -ne 0) { throw 'cap sync failed' }
    }

    # Release signing key.
    $keystoreDir = Join-Path $Tools 'keystore'
    $keystore = Join-Path $keystoreDir 'cheesefork-release.jks'
    $propertiesFile = Join-Path $Native 'keystore.properties'
    if (-not (Test-Path $keystore)) {
        Write-Host '== Creating a release signing key'
        New-Item -ItemType Directory -Force $keystoreDir | Out-Null
        $password = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
        & keytool -genkeypair -v -keystore $keystore -alias cheesefork -keyalg RSA -keysize 2048 -validity 10000 `
            -storepass $password -keypass $password -dname 'CN=CheeseFork, OU=Mobile, O=CheeseFork, L=Haifa, C=IL'
        if ($LASTEXITCODE -ne 0) { throw 'keytool failed' }
        $storeFile = $keystore -replace '\\', '/'
        @(
            "storeFile=$storeFile",
            "storePassword=$password",
            "keyAlias=cheesefork",
            "keyPassword=$password"
        ) | Set-Content -Path $propertiesFile -Encoding ascii
        Write-Host "Key saved to $keystore, password in $propertiesFile (both outside git)."
    } elseif (-not (Test-Path $propertiesFile)) {
        throw "Found $keystore but no $propertiesFile. Restore keystore.properties (storeFile/storePassword/keyAlias/keyPassword) or move the keystore away to generate a new one."
    }

    $task = if ($Debug) { 'assembleDebug' } else { 'assembleRelease' }
    Write-Host "== gradlew $task"
    Push-Location (Join-Path $Native 'android')
    try {
        & .\gradlew.bat $task --no-daemon
        if ($LASTEXITCODE -ne 0) { throw 'Gradle build failed' }
    } finally {
        Pop-Location
    }

    $variant = if ($Debug) { 'debug' } else { 'release' }
    $apk = Get-ChildItem "$Native\android\app\build\outputs\apk\$variant\*.apk" | Select-Object -First 1
    $dist = Join-Path $Native 'dist'
    New-Item -ItemType Directory -Force $dist | Out-Null
    $target = Join-Path $dist "CheeseFork-$variant.apk"
    Copy-Item $apk.FullName $target -Force
    Write-Host ''
    Write-Host "APK ready: $target ($([math]::Round((Get-Item $target).Length / 1MB, 1)) MB)"

    if ($Install) {
        Write-Host '== adb install'
        & adb install -r $target
    }
} finally {
    Pop-Location
}
