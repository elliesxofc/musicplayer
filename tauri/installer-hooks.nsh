; moonlit's installer: moving over from the old (Electron) moonlit.
; The old app is kept as a copy for a moment (the new moonlit starts it once to bring your
; library over, then deletes the copy), and the old install is removed, so the two never
; share shortcuts or file types.
!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$LOCALAPPDATA\Programs\moonlit\resources\app.asar" 0 moonlit_no_old
    DetailPrint "keeping a copy of the old moonlit, so your songs can come along"
    nsExec::Exec 'taskkill /F /IM "moonlit.exe"'
    Sleep 800
    RMDir /r "$LOCALAPPDATA\moonlit-old"
    CreateDirectory "$LOCALAPPDATA\moonlit-old"
    CopyFiles /SILENT "$LOCALAPPDATA\Programs\moonlit\*.*" "$LOCALAPPDATA\moonlit-old"
    DetailPrint "removing the old moonlit (your songs and settings stay)"
    IfFileExists "$LOCALAPPDATA\Programs\moonlit\Uninstall moonlit.exe" 0 moonlit_old_gone
      ExecWait '"$LOCALAPPDATA\Programs\moonlit\Uninstall moonlit.exe" /S _?=$LOCALAPPDATA\Programs\moonlit'
    moonlit_old_gone:
    RMDir /r "$LOCALAPPDATA\Programs\moonlit"
  moonlit_no_old:
!macroend
