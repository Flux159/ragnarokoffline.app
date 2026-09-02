# Install-and-verify loop for a Windows box with Defender on.
#
# Two questions, one script:
#
#   1. Does installing the guest images survive Defender's real-time scanner?
#      Issue #7 is a virtual machine that starts and whose guest emits nothing,
#      and the leading theory is a kernel or rootfs altered mid-write. It is a
#      race, not a certainty -- the dev box has survived it before -- so this
#      repeats and reports how often it fails, not merely whether it did.
#
#   2. How much is actually written? nebula 0.1.9 writes the zeros as holes;
#      before it, an install wrote about 3.2 GB to deliver 23 MB.
#
#   .\test-windows-install.ps1 -Runs 5
#
# Destructive: removes the nebula directory in %APPDATA%\Ragnarok Offline
# between runs. Save data lives in state\, which is left alone.

param([int]$Runs = 3)

$data   = "$env:APPDATA\Ragnarok Offline"
$nebula = "$data\nebula"
$rt     = "$data\runtime"
$stack  = "$rt\bin\ragnarok-stack.exe"

if (-not (Test-Path $stack)) { Write-Error "no supervisor at $stack -- install the app first"; exit 1 }

# What the shipped archives say the images should be: the last four bytes of a
# gzip stream are the uncompressed length, so this costs one seek rather than a
# gigabyte of decompression.
function Get-GzipSize([string]$Path) {
    $fs = [IO.File]::OpenRead($Path)
    try {
        $fs.Seek(-4, [IO.SeekOrigin]::End) | Out-Null
        $b = New-Object byte[] 4
        $fs.Read($b, 0, 4) | Out-Null
        [BitConverter]::ToUInt32($b, 0)
    } finally { $fs.Close() }
}

function Get-OnDisk([string]$Path) {
    # Allocated size, not apparent size: the whole point of a sparse write is
    # that these differ.
    $f = fsutil file queryallocatedranges $Path 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    ($f | Select-String 'Length: (0x[0-9a-f]+)' -AllMatches).Matches |
        ForEach-Object { [Convert]::ToInt64($_.Groups[1].Value, 16) } |
        Measure-Object -Sum | Select-Object -ExpandProperty Sum
}

$wantKernel = Get-GzipSize "$rt\guest\Image.gz"
$wantRootfs = Get-GzipSize "$rt\guest\rootfs.img.gz"
Write-Host "expected  kernel $wantKernel  rootfs $wantRootfs"
Write-Host "defender  realtime=$((Get-MpComputerStatus).RealTimeProtectionEnabled) exclusions=$(((Get-MpPreference).ExclusionPath | Measure-Object).Count)"
Write-Host ""

$fail = 0
for ($i = 1; $i -le $Runs; $i++) {
    Remove-Item -Recurse -Force $nebula -ErrorAction SilentlyContinue
    $sw = [Diagnostics.Stopwatch]::StartNew()
    & $stack up 2>&1 | Out-Null
    $sw.Stop()

    $k  = if (Test-Path "$nebula\kernel\Image") { (Get-Item "$nebula\kernel\Image").Length } else { 0 }
    $r  = if (Test-Path "$nebula\images\rootfs-pristine.img") { (Get-Item "$nebula\images\rootfs-pristine.img").Length } else { 0 }
    $rd = Get-OnDisk "$nebula\images\rootfs-pristine.img"
    $ok = ($k -eq $wantKernel) -and ($r -eq $wantRootfs)
    if (-not $ok) { $fail++ }

    $verdict = if ($ok) { "ok" } else { "DAMAGED kernel=$k rootfs=$r" }
    $disk    = if ($rd) { "{0} MB on disk" -f [math]::Round($rd / 1MB) } else { "on-disk unknown" }
    "run {0}/{1}  {2,6:n1}s  {3,-18} {4}" -f $i, $Runs, $sw.Elapsed.TotalSeconds, $disk, $verdict
    & $stack down 2>&1 | Out-Null
}

Write-Host ""
if ($fail -gt 0) {
    Write-Host "REPRODUCED: $fail of $Runs installs produced a damaged image" -ForegroundColor Red
} else {
    Write-Host "$Runs of $Runs installs intact -- not reproduced on this machine" -ForegroundColor Green
    Write-Host "A clean run does not clear Defender: the corruption is a race, and this box has survived it before."
}
