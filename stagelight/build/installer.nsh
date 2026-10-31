; electron-builder picks this file up by itself (build/installer.nsh).
; Stagelight's installer, extra steps (electron-builder's NSIS installer runs these).
; Installing: Windows asks once (Stagelight runs as administrator for a moment) to set up
; Stagelight's service and "always run as administrator". Skipped when the service is already
; there (an update: Stagelight updates it by itself) or when it's declined.
!macro customInstall
  nsExec::ExecToStack 'sc query StagelightService'
  Pop $0
  Pop $1
  ${If} $0 != 0
    ExecShellWait "runas" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" '--setup-service --config "$APPDATA\Stagelight\stagelight.json"' SW_HIDE
  ${EndIf}
!macroend

; Uninstalling for good (not an update): the service and the administrator task go too.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    nsExec::ExecToStack 'sc query StagelightService'
    Pop $0
    Pop $1
    ${If} $0 == 0
      ; with Windows' own commands (Stagelight's files may already be gone at this point)
      ExecShellWait "runas" "$SYSDIR\cmd.exe" '/c sc stop StagelightService & sc delete StagelightService & schtasks /Delete /F /TN "Stagelight (administrator)" & netsh advfirewall firewall delete rule name="Stagelight sign-in screen" & rmdir /s /q "$PROGRAMFILES64\Stagelight Service"' SW_HIDE
    ${EndIf}
  ${EndIf}
!macroend
