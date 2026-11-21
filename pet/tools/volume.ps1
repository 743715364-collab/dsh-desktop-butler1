# J.A.R.V.I.S. — system volume via CoreAudio (IAudioEndpointVolume).
#
# Actions: get | set | mute | unmute | toggle | up | down   (set needs -Level)
# Prints one line of UTF-8 JSON: {"ok":true,"volume":42,"muted":false}
#
# Media keys alone cannot answer "现在音量多少" or honour "调到 30%", so this
# talks to the endpoint directly through a tiny C# interop shim.
param(
  [ValidateSet('get', 'set', 'mute', 'unmute', 'toggle', 'up', 'down')][string]$Action = 'get',
  [int]$Level = -1
)

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch {
  # ASCII JSON still works
}

function Send-Json($value) {
  Write-Output ($value | ConvertTo-Json -Compress -Depth 4)
  exit 0
}

$source = @'
using System;
using System.Runtime.InteropServices;

namespace JarvisAudio {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  internal class MMDeviceEnumeratorComObject { }

  internal enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
  internal enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDeviceEnumerator {
    int NotImpl1();
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppDevice);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
  }

  // Vtable order matters: slots are declared in the order the COM interface lists them.
  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAudioEndpointVolume {
    int _0(); int _1(); int _2(); int _3();
    int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
    int _5();
    int GetMasterVolumeLevelScalar(out float level);
    int _7(); int _8(); int _9(); int _10();
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
    int GetMute(out bool mute);
    int _13(); int _14(); int _15(); int _16();
    int GetVolumeRange(out float min, out float max, out float inc);
  }

  public static class Volume {
    private static IAudioEndpointVolume Endpoint() {
      var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
      IMMDevice device;
      Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device));
      Guid iid = typeof(IAudioEndpointVolume).GUID;
      object o;
      Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out o));
      return (IAudioEndpointVolume)o;
    }
    public static int Get() {
      float v;
      Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out v));
      return (int)Math.Round(v * 100);
    }
    public static void Set(int pct) {
      Guid g = Guid.Empty;
      Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, pct)) / 100f, ref g));
    }
    public static void SetMute(bool on) {
      Guid g = Guid.Empty;
      Marshal.ThrowExceptionForHR(Endpoint().SetMute(on, ref g));
    }
    public static bool GetMute() {
      bool m;
      Marshal.ThrowExceptionForHR(Endpoint().GetMute(out m));
      return m;
    }
  }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp | Out-Null
} catch {
  Send-Json @{ ok = $false; error = 'audio interop failed: ' + $_.Exception.Message }
}

try {
  switch ($Action) {
    'get' { }
    'set' {
      if ($Level -lt 0) { Send-Json @{ ok = $false; error = 'missing level' } }
      [JarvisAudio.Volume]::Set($Level)
    }
    'mute' { [JarvisAudio.Volume]::SetMute($true) }
    'unmute' { [JarvisAudio.Volume]::SetMute($false) }
    'toggle' { [JarvisAudio.Volume]::SetMute(-not [JarvisAudio.Volume]::GetMute()) }
    'up' { [JarvisAudio.Volume]::Set([JarvisAudio.Volume]::Get() + 8) }
    'down' { [JarvisAudio.Volume]::Set([JarvisAudio.Volume]::Get() - 8) }
  }

  Send-Json @{
    ok = $true
    volume = [JarvisAudio.Volume]::Get()
    muted = [JarvisAudio.Volume]::GetMute()
  }
} catch {
  Send-Json @{ ok = $false; error = $_.Exception.Message }
}
