' Muse4AI zh-CN auto patch checker (run hidden by Task Scheduler every 5 minutes and at logon).
' Patches every installed app-* version whose app.asar has no zh patch marker yet.
' app.asar can only be replaced while Muse4AI is not running, so if it is running this run is skipped
' and the patch is applied on a later check, after you quit the app.
Option Explicit
Dim fso, sh, root, here, folder, need, q, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Muse4AI"
here = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FolderExists(root) Then WScript.Quit
need = False
For Each folder In fso.GetFolder(root).SubFolders
  If Left(folder.Name, 4) = "app-" Then
    If fso.FileExists(folder.Path & "\resources\app.asar.orig") Or fso.FileExists(folder.Path & "\resources\app.asar") Then
      If Not fso.FileExists(folder.Path & "\resources\.zh-patch.json") Then need = True
    End If
  End If
Next
If Not need Then WScript.Quit
q = Chr(34)
cmd = "cmd /c tasklist /fi " & q & "imagename eq Muse4AI.exe" & q & " /nh | find /i " & q & "Muse4AI.exe" & q & " >nul 2>nul"
If sh.Run(cmd, 0, True) = 0 Then WScript.Quit
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & q & here & "\run-patch.ps1" & q & " -Quiet", 0, False