; ---------------------------------------------------------------------------------------
; PeerLink installer customisation
;
; Two coordinated mechanisms:
;
;   1. electron-builder's `displayLanguageSelector` shows NSIS's standard language picker
;      ("Language / Limbă" with English and Română). Choosing Romanian switches the whole
;      wizard - buttons, headers, all standard pages - because NSIS ships that translation.
;
;   2. On install we record the choice under
;         HKCU\Software\PeerLink : Language = en | ro
;      which the app reads on first run (src/main/settings.ts -> installerLanguage()).
;
; HKCU rather than HKLM: the installer is per-user, so there is no elevation prompt and the
; app always runs as the same user that installed it.
; ---------------------------------------------------------------------------------------

!include "MUI2.nsh"
!include "LogicLib.nsh"

!define PEERLINK_LANG_EN 1033
!define PEERLINK_LANG_RO 1048

; electron-builder treats NSIS warnings as errors, and its message files carry no Romanian
; translation, so the strings its wizard pages would otherwise leave to the English fallback
; are supplied by scripts/patch-nsis-romanian.js (which patches NSIS's Romanian.nsh, the file
; that is genuinely missing them upstream).
;
; Note: electron-builder's own messages (chooseInstallationOptions, onlyForMe, ...) must NOT
; be repeated here - it generates them itself, and a second definition is a "set multiple
; times" warning, which its build treats as fatal.

!macro customInstall
  ; $LANGUAGE holds the picker's answer. Silent installs (/S) skip the picker and get the
  ; NSIS system language, so fall back to whatever is already recorded before defaulting.
  StrCpy $R0 ""
  ${If} $LANGUAGE == ${PEERLINK_LANG_RO}
    StrCpy $R0 "ro"
  ${ElseIf} $LANGUAGE == ${PEERLINK_LANG_EN}
    StrCpy $R0 "en"
  ${EndIf}

  ${If} $R0 == ""
    ReadRegStr $R1 HKCU "Software\PeerLink" "Language"
    ${If} $R1 == "ro"
      StrCpy $R0 "ro"
    ${Else}
      StrCpy $R0 "en"
    ${EndIf}
  ${EndIf}

  WriteRegStr HKCU "Software\PeerLink" "Language" "$R0"
  DetailPrint "PeerLink UI language / Limba interfeței: $R0"
!macroend
