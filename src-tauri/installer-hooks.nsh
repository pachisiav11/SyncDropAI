; Puts SyncDrop where Windows expects a "share with" target to be.
;
; Windows has no share sheet a plain desktop app can join - the Share contract
; is only open to MSIX-packaged apps - so the two places users actually look
; are the "Send to" submenu and the right-click menu. Both are registered here,
; both per-user to match the currentUser install mode, and both removed again
; on uninstall.
;
; Either route starts SyncDrop with the file path on the command line. The
; running window picks it up through the single-instance plugin, so sharing a
; file never opens a second copy of the app.

!macro NSIS_HOOK_POSTINSTALL
  SetShellVarContext current

  CreateShortcut "$SENDTO\SyncDrop.lnk" "$INSTDIR\SyncDrop.exe"

  ; Right-click on any file: "Send with SyncDrop". On Windows 11 this sits
  ; under "Show more options", which is where every unpackaged app lands.
  WriteRegStr HKCU "Software\Classes\*\shell\SyncDrop" "" "Send with SyncDrop"
  WriteRegStr HKCU "Software\Classes\*\shell\SyncDrop" "Icon" "$INSTDIR\SyncDrop.exe"
  WriteRegStr HKCU "Software\Classes\*\shell\SyncDrop" "MultiSelectModel" "Document"
  WriteRegStr HKCU "Software\Classes\*\shell\SyncDrop\command" "" '"$INSTDIR\SyncDrop.exe" "%1"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  SetShellVarContext current

  Delete "$SENDTO\SyncDrop.lnk"
  DeleteRegKey HKCU "Software\Classes\*\shell\SyncDrop"
!macroend
