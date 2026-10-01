param(
    [Parameter(Mandatory=$true)][string]$Url,
    [Parameter(Mandatory=$true)][string]$DestinationPath,
    [Parameter(Mandatory=$false)][string]$ExpectedSha256
)

$ErrorActionPreference = "Stop"

try {
    $parentDir = Split-Path -Parent $DestinationPath
    if ($parentDir -and -not (Test-Path $parentDir)) {
        New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
    }

    Write-Host "[PrintGo Artifact Downloader] Downloading: $Url"
    Write-Host "[PrintGo Artifact Downloader] Target: $DestinationPath"

    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12 -bor [System.Net.SecurityProtocolType]::Tls13

    Invoke-WebRequest -Uri $Url -OutFile $DestinationPath -UseBasicParsing

    if (-not (Test-Path $DestinationPath)) {
        throw "Downloaded file was not found at $DestinationPath"
    }

    $actualSha256 = (Get-FileHash -Path $DestinationPath -Algorithm SHA256).Hash.ToLower()
    Write-Host "[PrintGo Artifact Downloader] Computed SHA-256: $actualSha256"

    if ($ExpectedSha256) {
        $expected = $ExpectedSha256.Trim().ToLower()
        if ($actualSha256 -ne $expected) {
            Remove-Item -Path $DestinationPath -Force -ErrorAction SilentlyContinue
            throw "Checksum mismatch! Expected: $expected, Actual: $actualSha256"
        }
        Write-Host "[PrintGo Artifact Downloader] Checksum verified successfully."
    }

    Write-Host "[PrintGo Artifact Downloader] Download and verification completed."
    exit 0
} catch {
    Write-Error "[PrintGo Artifact Downloader ERROR] $_"
    exit 1
}
