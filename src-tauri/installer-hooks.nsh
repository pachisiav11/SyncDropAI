; Puts SyncDrop everywhere Windows offers to send a file somewhere else: the
; Share dialog and Explorer's "Share with" menu, the "Send to" submenu, and the
; right-click menu. All of it is per-user to match the currentUser install
; mode, and all of it is removed again on uninstall.
;
; The Share contract only lists apps with a package identity. A package with
; an external location gives this install one without moving a file: it
; registers AppxManifest.xml and points it at $INSTDIR. Windows accepts an
; unsigned one only in Developer Mode, so elsewhere the registration fails
; quietly and the other two routes remain.
;
; Every route ends with SyncDrop holding the file paths. The running window
; picks them up through the single-instance plugin, so sharing a file never
; opens a second copy of the app.

!macro NSIS_HOOK_POSTINSTALL
  SetShellVarContext current

  CreateShortcut "$SENDTO\SyncDrop.lnk" "$INSTDIR\SyncDrop.exe"

  ; Right-click on any file: "Send with SyncDrop". On Windows 11 this sits
  ; under "Show more options", which is where every unpackaged app lands.
  WriteRegStr HKCU "Software\Classes\*\shell\SyncDrop" "" "Send with SyncDrop"
  WriteRegStr HKCU "Software\Classes\*\shell\SyncDrop" "Icon" "$INSTDIR\SyncDrop.exe"
  WriteRegStr HKCU "Software\Classes\*\shell\SyncDrop" "MultiSelectModel" "Document"
  WriteRegStr HKCU "Software\Classes\*\shell\SyncDrop\command" "" '"$INSTDIR\SyncDrop.exe" "%1"'

  ; Removed first so a reinstall over an older registration starts clean.
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-AppxPackage -Name SyncDrop | Remove-AppxPackage; Add-AppxPackage -Register '$INSTDIR\AppxManifest.xml' -ExternalLocation '$INSTDIR'"`
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  SetShellVarContext current

  Delete "$SENDTO\SyncDrop.lnk"
  DeleteRegKey HKCU "Software\Classes\*\shell\SyncDrop"

  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-AppxPackage -Name SyncDrop | Remove-AppxPackage"`
  Pop $0
!macroend
