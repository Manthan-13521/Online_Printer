; PrintGo V2 — Professional Windows Inno Setup Script
; Generates PrintGo-Setup.exe for non-technical print shop owners

#define MyAppName "PrintGo for Windows"
#define MyAppVersion "2.1.0"
#define MyAppPublisher "PrintGo Systems"
#define MyAppExeName "PrintGo-ControlCenter.exe"
#define MyAgentExeName "PrintGo-Agent.exe"

[Setup]
; Unique GUID for PrintGo Windows installation
AppId={{E1D3B51A-9781-4C5C-9A88-755776DBE519}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\PrintGo
DefaultGroupName=PrintGo
DisableProgramGroupPage=yes
LicenseFile=..\THIRD_PARTY_NOTICES.txt
PrivilegesRequired=lowest
CloseApplications=no
RestartApplications=no
OutputDir=dist
OutputBaseFilename=PrintGo-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "startwithwindows"; Description: "Start PrintGo automatically when Windows starts"; GroupDescription: "Startup options:"
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "stage\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "stage\{#MyAgentExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "stage\SumatraPDF.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "stage\THIRD_PARTY_NOTICES.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\PrintGo\PrintGo Control Center"; Filename: "{app}\{#MyAppExeName}"
Name: "{autoprograms}\PrintGo\Uninstall PrintGo"; Filename: "{uninstallexe}"
Name: "{autodesktop}\PrintGo Control Center"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
; Windows user-session auto-start at login
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "PrintGoControlCenter"; ValueData: """{app}\{#MyAppExeName}"" --minimized"; Flags: uninsdeletevalue; Tasks: startwithwindows

; Register printgo:// URL protocol for one-click pairing from Admin Portal
Root: HKCU; Subkey: "Software\Classes\printgo"; ValueType: string; ValueName: ""; ValueData: "URL:PrintGo Protocol"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\printgo"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\printgo\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""; Flags: uninsdeletekey

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,PrintGo Control Center}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Clean up temp files if any in app folder, but DO NOT delete %LOCALAPPDATA%\PrintGo (preserves DPAPI credentials)
Type: files; Name: "{app}\*.tmp"

[Code]
function MaintenanceBlocked(): Boolean;
var Locator, Services, Processes: Variant;
begin
  Result := True;
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Services := Locator.ConnectServer('', 'root\CIMV2');
    Processes := Services.ExecQuery('SELECT ProcessId FROM Win32_Process WHERE Name = ''PrintGo-Agent.exe'' OR Name = ''PrintGo-ControlCenter.exe'' OR Name = ''SumatraPDF.exe''');

    Result := (Processes.Count > 0) or FileExists(ExpandConstant('{localappdata}\PrintGo\active-print.json'));
  except
    Result := True;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if MaintenanceBlocked() then
    Result := 'Setup is deferred. Pause new orders and finish or resolve all prints. Close PrintGo and the PDF viewer before maintenance. No running process will be stopped by Setup.';
end;

function InitializeUninstall(): Boolean;
begin
  Result := not MaintenanceBlocked();
  if not Result then
    MsgBox('Uninstall is deferred while PrintGo is running or a print needs review. Resolve printing and close PrintGo first.', mbInformation, MB_OK);
end;
