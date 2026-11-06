# Sends a file's bytes to a Windows printer as RAW data (no driver formatting).
# Used by printer-bridge.js to push an ESC/POS receipt straight to the POS-80C.
#   powershell -NoProfile -ExecutionPolicy Bypass -File raw-print.ps1 -Path bill.bin -Printer BILL
# Prints "OK" on success, otherwise "ERROR: <winspool failure>".
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Printer = "BILL"
)

$ErrorActionPreference = "Stop"

$source = @"
using System;
using System.Runtime.InteropServices;

public class RawPrinter
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DOCINFOA
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype;
    }

    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

    public static string Send(byte[] bytes, string printerName)
    {
        IntPtr hPrinter = IntPtr.Zero;
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
            return "ERROR: OpenPrinter('" + printerName + "') failed, code " + Marshal.GetLastWin32Error();

        try
        {
            DOCINFOA di = new DOCINFOA();
            di.pDocName = "Zeva Bill";
            di.pDatatype = "RAW";
            di.pOutputFile = null;

            if (!StartDocPrinter(hPrinter, 1, di))
                return "ERROR: StartDocPrinter failed, code " + Marshal.GetLastWin32Error();

            try
            {
                if (!StartPagePrinter(hPrinter))
                    return "ERROR: StartPagePrinter failed, code " + Marshal.GetLastWin32Error();

                IntPtr buffer = Marshal.AllocCoTaskMem(bytes.Length);
                try
                {
                    Marshal.Copy(bytes, 0, buffer, bytes.Length);
                    int written = 0;
                    if (!WritePrinter(hPrinter, buffer, bytes.Length, out written))
                        return "ERROR: WritePrinter failed, code " + Marshal.GetLastWin32Error();
                    if (written != bytes.Length)
                        return "ERROR: only " + written + " of " + bytes.Length + " bytes written";
                }
                finally
                {
                    Marshal.FreeCoTaskMem(buffer);
                }

                EndPagePrinter(hPrinter);
            }
            finally
            {
                EndDocPrinter(hPrinter);
            }
        }
        finally
        {
            ClosePrinter(hPrinter);
        }

        return "OK";
    }
}
"@

Add-Type -TypeDefinition $source -Language CSharp

if (-not (Test-Path -LiteralPath $Path)) {
  Write-Output "ERROR: file not found: $Path"
  exit 1
}

$bytes = [System.IO.File]::ReadAllBytes($Path)
if ($bytes.Length -eq 0) {
  Write-Output "ERROR: refusing to print an empty job"
  exit 1
}

$result = [RawPrinter]::Send($bytes, $Printer)
Write-Output $result
if ($result -ne "OK") { exit 1 }
