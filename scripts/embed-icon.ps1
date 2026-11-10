param(
    [Parameter(Mandatory=$true)][string]$ExePath,
    [Parameter(Mandatory=$true)][string]$IcoPath
)

$ErrorActionPreference = "Stop"

$csharp = @"
using System;
using System.IO;
using System.Runtime.InteropServices;

public static class PeIconUpdater {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr BeginUpdateResourceW(string pFileName, bool bDeleteExistingResources);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateResourceW(
        IntPtr hUpdate,
        IntPtr lpType,
        IntPtr lpName,
        ushort wLanguage,
        byte[] lpData,
        uint cbData
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool EndUpdateResourceW(IntPtr hUpdate, bool fDiscard);

    private static IntPtr MakeIntResource(int id) {
        return new IntPtr(id);
    }

    public static void ApplyIcon(string exePath, string icoPath) {
        byte[] icoBytes = File.ReadAllBytes(icoPath);
        using (MemoryStream ms = new MemoryStream(icoBytes))
        using (BinaryReader br = new BinaryReader(ms)) {
            ushort reserved = br.ReadUInt16();
            ushort type = br.ReadUInt16();
            ushort count = br.ReadUInt16();
            if (reserved != 0 || type != 1 || count == 0) {
                throw new InvalidDataException("Invalid ICO file header.");
            }

            byte[] widths = new byte[count];
            byte[] heights = new byte[count];
            byte[] colorCounts = new byte[count];
            byte[] reserveds = new byte[count];
            ushort[] planes = new ushort[count];
            ushort[] bitCounts = new ushort[count];
            uint[] bytesInRes = new uint[count];
            uint[] imageOffsets = new uint[count];

            for (int i = 0; i < count; i++) {
                widths[i] = br.ReadByte();
                heights[i] = br.ReadByte();
                colorCounts[i] = br.ReadByte();
                reserveds[i] = br.ReadByte();
                planes[i] = br.ReadUInt16();
                bitCounts[i] = br.ReadUInt16();
                bytesInRes[i] = br.ReadUInt32();
                imageOffsets[i] = br.ReadUInt32();
            }

            IntPtr hUpdate = BeginUpdateResourceW(exePath, false);
            if (hUpdate == IntPtr.Zero) {
                throw new IOException("BeginUpdateResourceW failed: " + Marshal.GetLastWin32Error());
            }

            ushort langEnUs = 1033; // 0x0409 (used by electron.exe)
            ushort langNeutral = 0;

            using (MemoryStream grpMs = new MemoryStream())
            using (BinaryWriter grpBw = new BinaryWriter(grpMs)) {
                grpBw.Write((ushort)0);
                grpBw.Write((ushort)1);
                grpBw.Write(count);

                for (int i = 0; i < count; i++) {
                    ushort iconId = (ushort)(i + 1);
                    byte[] imgData = new byte[bytesInRes[i]];
                    Buffer.BlockCopy(icoBytes, (int)imageOffsets[i], imgData, 0, (int)bytesInRes[i]);

                    // RT_ICON = 3
                    if (!UpdateResourceW(hUpdate, MakeIntResource(3), MakeIntResource(iconId), langEnUs, imgData, (uint)imgData.Length)) {
                        throw new IOException("UpdateResourceW(RT_ICON) failed: " + Marshal.GetLastWin32Error());
                    }

                    // GRPICONDIRENTRY (14 bytes each)
                    grpBw.Write(widths[i]);
                    grpBw.Write(heights[i]);
                    grpBw.Write(colorCounts[i]);
                    grpBw.Write(reserveds[i]);
                    grpBw.Write(planes[i]);
                    grpBw.Write(bitCounts[i]);
                    grpBw.Write(bytesInRes[i]);
                    grpBw.Write(iconId);
                }

                grpBw.Flush();
                byte[] grpBytes = grpMs.ToArray();

                // Electron uses string resource name "IDR_MAINFRAME" or ID 1 for RT_GROUP_ICON (14)
                IntPtr idrMainframePtr = Marshal.StringToHGlobalUni("IDR_MAINFRAME");
                try {
                    UpdateResourceW(hUpdate, MakeIntResource(14), idrMainframePtr, langEnUs, grpBytes, (uint)grpBytes.Length);
                    UpdateResourceW(hUpdate, MakeIntResource(14), MakeIntResource(1), langEnUs, grpBytes, (uint)grpBytes.Length);
                    UpdateResourceW(hUpdate, MakeIntResource(14), MakeIntResource(1), langNeutral, grpBytes, (uint)grpBytes.Length);
                } finally {
                    Marshal.FreeHGlobal(idrMainframePtr);
                }
            }

            if (!EndUpdateResourceW(hUpdate, false)) {
                throw new IOException("EndUpdateResourceW failed: " + Marshal.GetLastWin32Error());
            }
        }
    }
}
"@

Add-Type -TypeDefinition $csharp -Language CSharp
[PeIconUpdater]::ApplyIcon($ExePath, $IcoPath)
Write-Output "Embedded icon $IcoPath into $ExePath successfully."
