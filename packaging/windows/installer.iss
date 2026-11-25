; Windows installer for Energy Monitoring Management (Inno Setup 6).
; Built by .github/workflows/installers.yml:  iscc /DAppVersion=1.5.0 packaging\windows\installer.iss
#ifndef AppVersion
  #define AppVersion "1.5.0"
#endif

[Setup]
AppId={{6E4B1C2A-8F3D-4B7E-9A51-3C2D7E0F9B11}
AppName=Energy Monitoring
AppVersion={#AppVersion}
AppVerName=Energy Monitoring {#AppVersion}
AppPublisher=Energy Monitoring Management
DefaultDirName={autopf}\Energy Monitoring
DefaultGroupName=Energy Monitoring
DisableProgramGroupPage=yes
OutputDir=..\..\dist
OutputBaseFilename=EnergyMonitoring-Setup-{#AppVersion}
SetupIconFile=..\icon.ico
UninstallDisplayIcon={app}\EnergyMonitoring.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
CloseApplications=force

[Tasks]
Name: "autostart"; Description: "Start logging automatically when Windows starts (recommended on the plant PC)"
Name: "desktopicon"; Description: "Create a desktop shortcut"
Name: "firewall"; Description: "Allow phones and other PCs on the plant network to open the dashboard (Windows Firewall)"

[Files]
Source: "..\..\dist\EnergyMonitoring\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Energy Monitoring"; Filename: "{app}\EnergyMonitoring.exe"
Name: "{group}\Stop logging"; Filename: "{app}\EnergyMonitoring.exe"; Parameters: "--stop"; IconFilename: "{app}\EnergyMonitoring.exe"
Name: "{group}\Uninstall Energy Monitoring"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Energy Monitoring"; Filename: "{app}\EnergyMonitoring.exe"; Tasks: desktopicon
Name: "{userstartup}\Energy Monitoring logger"; Filename: "{app}\EnergyMonitoring.exe"; Parameters: "--server"; Tasks: autostart

[Run]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Energy Monitoring"""; Flags: runhidden; Tasks: firewall
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Energy Monitoring"" dir=in action=allow program=""{app}\EnergyMonitoring.exe"" enable=yes profile=private,domain"; Flags: runhidden; Tasks: firewall
Filename: "{app}\EnergyMonitoring.exe"; Description: "Open Energy Monitoring now"; Flags: nowait postinstall skipifsilent runasoriginaluser

[UninstallRun]
Filename: "{app}\EnergyMonitoring.exe"; Parameters: "--stop"; Flags: runhidden; RunOnceId: "StopLogger"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Energy Monitoring"""; Flags: runhidden; RunOnceId: "DelFirewall"

; Settings and logged data stay in %LOCALAPPDATA%\Energy Monitoring, so uninstalling or updating never deletes them.
