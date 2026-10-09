; Registers Operecs as a web browser for the current user, so it shows up in
; Settings -> Apps -> Default apps and can be chosen for http/https links and .html files.
; Layout follows Microsoft's "Registering Programs with Client Types" (StartMenuInternet)
; and "Default Programs" (RegisteredApplications / Capabilities) documentation.
; electron-builder includes this file through build.nsis.include.

!macro customInstall
  ; ProgIDs the capabilities point at
  WriteRegStr HKCU "Software\Classes\OperecsURL" "" "Operecs URL"
  WriteRegStr HKCU "Software\Classes\OperecsURL" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\OperecsURL\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\OperecsURL\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\OperecsHTML" "" "Operecs HTML Document"
  WriteRegStr HKCU "Software\Classes\OperecsHTML\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\OperecsHTML\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; the browser itself
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Operecs" "" "Operecs"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Operecs\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Operecs\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Operecs\Capabilities" "ApplicationName" "Operecs"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Operecs\Capabilities" "ApplicationDescription" "A fast, private web browser"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Operecs\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Operecs\Capabilities\StartMenu" "StartMenuInternet" "Operecs"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Operecs\Capabilities\URLAssociations" "http" "OperecsURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Operecs\Capabilities\URLAssociations" "https" "OperecsURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Operecs\Capabilities\FileAssociations" ".html" "OperecsHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Operecs\Capabilities\FileAssociations" ".htm" "OperecsHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Operecs\Capabilities\FileAssociations" ".xhtml" "OperecsHTML"
  WriteRegStr HKCU "Software\RegisteredApplications" "Operecs" "Software\Clients\StartMenuInternet\Operecs\Capabilities"

  ; tell Explorer that associations changed (SHCNE_ASSOCCHANGED)
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller first; keep the registration then (the new version
  ; writes it again) so the user's default-browser choice survives updates.
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\RegisteredApplications" "Operecs"
    DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Operecs"
    DeleteRegKey HKCU "Software\Classes\OperecsURL"
    DeleteRegKey HKCU "Software\Classes\OperecsHTML"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${endIf}
!macroend
