; Install the Microsoft Visual C++ runtime if this machine does not have it.
;
; Every binary in payload/bin imports VCRUNTIME140.dll -- ragnarok-stack,
; nebula, nebulad, docker-slim and robrowser-remoteclient. The Electron shell
; is the one thing that does not, so without the redistributable the app opens
; normally and then fails the instant it tries to start the servers, with
; 0xC0000135. A player hit exactly that and had to work out the cause alone.
;
; scripts/package.sh fetches vc_redist.x64.exe into the buildResources
; directory when packaging on Windows. The guard below keeps a build that has
; no copy of it -- a Mac or Linux run, or a dev build -- from failing to
; compile the installer.

!include "x64.nsh"

!macro customInstall
  !if /FileExists "${BUILD_RESOURCES_DIR}\vc_redist.x64.exe"
    ; A 64-bit process resolves VCRUNTIME140.dll from System32, but NSIS is a
    ; 32-bit process: without disabling redirection this reads SysWOW64 and
    ; finds the 32-bit copy, which is not the one our binaries need.
    ${DisableX64FSRedirection}
    ${If} ${FileExists} "$WINDIR\System32\VCRUNTIME140.dll"
      DetailPrint "Microsoft Visual C++ runtime already present."
      ${EnableX64FSRedirection}
    ${Else}
      ${EnableX64FSRedirection}
      DetailPrint "Installing the Microsoft Visual C++ Redistributable (x64)..."
      DetailPrint "Windows may ask for permission -- this is Microsoft's own installer."
      InitPluginsDir
      File "/oname=$PLUGINSDIR\vc_redist.x64.exe" "${BUILD_RESOURCES_DIR}\vc_redist.x64.exe"
      ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart' $0
      Delete "$PLUGINSDIR\vc_redist.x64.exe"
      ; 0 installed, 1638 a newer version is already there, 3010 installed and
      ; wants a reboot. None of the three is a reason to stop.
      ${If} $0 == 0
      ${OrIf} $0 == 1638
      ${OrIf} $0 == 3010
        DetailPrint "Microsoft Visual C++ Redistributable is installed."
      ${Else}
        DetailPrint "The Visual C++ Redistributable did not install (code $0)."
        DetailPrint "Ragnarok Offline will not start until it is installed from:"
        DetailPrint "https://aka.ms/vs/17/release/vc_redist.x64.exe"
      ${EndIf}
    ${EndIf}
  !else
    ; Deliberately fatal. electron-builder runs makensis with warnings as
    ; errors anyway, and an installer that silently omits the runtime would
    ; ship the exact failure this exists to prevent -- discovered only by a
    ; player, on their machine, as "it just will not start".
    !error "vc_redist.x64.exe is not in BUILD_RESOURCES_DIR. \
            Run scripts/package.sh on Windows to fetch it before packaging."
  !endif
!macroend
