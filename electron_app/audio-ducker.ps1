# audio-ducker.ps1 - Baja el volumen de los demás programas mientras la app lee la traducción en voz alta (solo Windows)
#
# Recibe órdenes por la entrada estándar, una por línea:
#   duck <nivel 0-1> <nombre del proceso que NO se toca>   baja los demás programas a ese nivel (relativo a su volumen)
#   restore                                                 devuelve cada programa a su volumen
#   exit                                                    restaura y termina
# Si la app que lo lanzó se cierra (se corta la entrada estándar), restaura y termina.
# Los volúmenes originales se guardan también en disco: si este proceso muere a la fuerza, la siguiente ejecución los restaura.

param([string]$StateFile = (Join-Path $env:TEMP 'vibetranslate-ducker-state.txt'))
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class DkDeviceEnumerator {}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDkDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IDkDeviceCollection devices);
}

[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDkDeviceCollection {
  [PreserveSig] int GetCount(out int count);
  [PreserveSig] int Item(int index, out IDkDevice device);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDkDevice {
  [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
}

[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDkSessionManager2 {
  int NotImpl1();
  int NotImpl2();
  [PreserveSig] int GetSessionEnumerator(out IDkSessionEnumerator sessions);
}

[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDkSessionEnumerator {
  [PreserveSig] int GetCount(out int count);
  [PreserveSig] int GetSession(int index, out IDkSessionControl2 session);
}

[Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDkSessionControl2 {
  int GetState(out int state);
  int GetDisplayName(out IntPtr name);
  int SetDisplayName(IntPtr name, IntPtr context);
  int GetIconPath(out IntPtr path);
  int SetIconPath(IntPtr path, IntPtr context);
  int GetGroupingParam(out Guid group);
  int SetGroupingParam(ref Guid group, IntPtr context);
  int RegisterAudioSessionNotification(IntPtr client);
  int UnregisterAudioSessionNotification(IntPtr client);
  int GetSessionIdentifier(out IntPtr id);
  [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetProcessId(out uint pid);
}

[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDkSimpleVolume {
  [PreserveSig] int SetMasterVolume(float level, ref Guid context);
  [PreserveSig] int GetMasterVolume(out float level);
}

public static class Ducker {
  static readonly object Gate = new object();
  static readonly Dictionary<string, float> Originals = new Dictionary<string, float>(); // sesión -> volumen antes de bajarla
  static Timer timer;
  static float level = 1f;
  static string keepProcess = "";
  static string stateFile;

  public static void Init(string file) {
    stateFile = file;
    // Un cierre a la fuerza anterior pudo dejar programas bajados: se restauran antes de nada
    if (File.Exists(stateFile)) {
      foreach (var line in File.ReadAllLines(stateFile)) {
        int cut = line.LastIndexOf('|');
        float v;
        if (cut > 0 && float.TryParse(line.Substring(cut + 1), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out v)) Originals[line.Substring(0, cut)] = v;
      }
      Restore();
    }
  }

  delegate void Visit(string id, uint pid, IDkSimpleVolume volume);

  static void EachSession(Visit visit) {
    var enumerator = (IDkDeviceEnumerator)(new DkDeviceEnumerator());
    IDkDeviceCollection devices;
    if (enumerator.EnumAudioEndpoints(0, 1, out devices) != 0) return; // salidas activas
    int deviceCount; devices.GetCount(out deviceCount);
    for (int d = 0; d < deviceCount; d++) {
      IDkDevice device; if (devices.Item(d, out device) != 0) continue;
      var iid = typeof(IDkSessionManager2).GUID; object manager;
      if (device.Activate(ref iid, 23, IntPtr.Zero, out manager) != 0) continue;
      IDkSessionEnumerator sessions;
      if (((IDkSessionManager2)manager).GetSessionEnumerator(out sessions) != 0) continue;
      int count; sessions.GetCount(out count);
      for (int i = 0; i < count; i++) {
        IDkSessionControl2 session; if (sessions.GetSession(i, out session) != 0) continue;
        string id; uint pid;
        if (session.GetSessionInstanceIdentifier(out id) != 0 || id == null) continue;
        session.GetProcessId(out pid);
        var volume = session as IDkSimpleVolume;
        if (volume != null) visit(id, pid, volume);
      }
    }
  }

  static bool IsOurs(uint pid) {
    if (pid == 0 || keepProcess.Length == 0) return false;
    try { return string.Equals(Process.GetProcessById((int)pid).ProcessName, keepProcess, StringComparison.OrdinalIgnoreCase); }
    catch { return false; }
  }

  static void Apply() {
    lock (Gate) {
      if (level >= 1f) return;
      var none = Guid.Empty;
      bool changed = false;
      EachSession((id, pid, volume) => {
        if (IsOurs(pid) || Originals.ContainsKey(id)) return; // lo nuestro no se toca; lo ya bajado tampoco se vuelve a bajar
        float current; if (volume.GetMasterVolume(out current) != 0) return;
        Originals[id] = current;
        volume.SetMasterVolume(current * level, ref none);
        changed = true;
      });
      if (changed) Save();
    }
  }

  static void Save() {
    var lines = new List<string>();
    foreach (var pair in Originals) lines.Add(pair.Key + "|" + pair.Value.ToString(System.Globalization.CultureInfo.InvariantCulture));
    File.WriteAllLines(stateFile, lines.ToArray());
  }

  public static int Duck(float newLevel, string processToKeep) {
    Restore();
    lock (Gate) { level = Math.Max(0f, Math.Min(1f, newLevel)); keepProcess = processToKeep ?? ""; }
    Apply();
    // Los programas que empiecen a sonar después también se bajan
    timer = new Timer(_ => { try { Apply(); } catch { } }, null, 1000, 1000);
    lock (Gate) { return Originals.Count; }
  }

  public static int Restore() {
    lock (Gate) {
      if (timer != null) { timer.Dispose(); timer = null; }
      level = 1f;
      var none = Guid.Empty;
      int restored = 0;
      EachSession((id, pid, volume) => {
        float original;
        if (Originals.TryGetValue(id, out original)) { volume.SetMasterVolume(original, ref none); restored++; }
      });
      Originals.Clear();
      if (stateFile != null && File.Exists(stateFile)) File.Delete(stateFile);
      return restored;
    }
  }
}
'@

[Ducker]::Init($StateFile)
[Console]::Out.WriteLine('ready')

try {
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }   # la app se cerró
    $parts = $line.Trim() -split '\s+', 3
    switch ($parts[0]) {
      'duck' {
        $level = [float]::Parse($parts[1], [System.Globalization.CultureInfo]::InvariantCulture)
        $keep = if ($parts.Count -gt 2) { $parts[2] } else { '' }
        [Console]::Out.WriteLine("ducked $([Ducker]::Duck($level, $keep))")
      }
      'restore' { [Console]::Out.WriteLine("restored $([Ducker]::Restore())") }
      'exit' { break }
    }
    if ($parts[0] -eq 'exit') { break }
  }
} finally {
  [void][Ducker]::Restore()
}
