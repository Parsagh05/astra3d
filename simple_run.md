Do this exactly:

1. Turn off VPN on both phone and laptop.
2. Confirm both devices use the same Wi‑Fi.
3. On Android, turn **Wireless debugging off**, wait a few seconds, then turn it back on.
4. In PowerShell, restart ADB:

```powershell
cd C:\platform-tools
.\adb.exe kill-server
.\adb.exe start-server
.\adb.exe devices
```

5. On the phone, select:

```text
Wireless debugging → Pair device with pairing code
```

Keep that window open. It displays:

- A temporary pairing IP/port
- A new six-digit pairing code

Immediately run, using the newly displayed pairing port:

```powershell
.\adb.exe pair 192.168.1.3:NEW_PAIRING_PORT
```

Enter the new code. Do not reuse `43049` or `007727`; they have probably expired.

After it says `Successfully paired`, close the pairing dialog. On the main **Wireless debugging** screen, find the separate IP address and port under “IP address & port.” Then run:

```powershell
.\adb.exe connect 192.168.1.3:CONNECTION_PORT
.\adb.exe devices
```

The connection port is not the pairing port.

Then copy the exact device name returned by `adb devices`:

```powershell
.\adb.exe -s "EXACT_DEVICE_NAME" reverse tcp:3000 tcp:3000
```

Start Astra3D in another terminal:

```powershell
cd C:\Users\USER\Desktop\astra3d
npm.cmd run dev
```

Open this on the phone:

```text
http://localhost:3000/studio
```

If pairing still reports `protocol fault`, update platform-tools. Check the version:

```powershell
C:\platform-tools\adb.exe version
```

Download the latest **SDK Platform-Tools for Windows** from Google, extract it over/into a fresh `C:\platform-tools` directory, and repeat the steps. Also allow `adb.exe` through Windows Firewall if prompted.