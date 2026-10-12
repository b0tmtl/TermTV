# Installing TermTV on a Samsung TV (sideload)

Samsung TVs only install signed apps. Until TermTV is in the Samsung store, you install it yourself in
**developer mode**, with a free Samsung certificate that is tied to your TV. It takes about 20 minutes
the first time; updates are one command after that.

What you need:

- a Samsung Smart TV from 2018 or newer (Tizen 4.0+), on the same network as your computer;
- a Windows, macOS or Linux computer;
- a free Samsung account.

## 1. Turn on developer mode on the TV

1. Find your computer's IP address (Windows: `ipconfig` · macOS / Linux: `ip addr` or System Settings → Network).
2. On the TV, open **Apps** (Smart Hub → Apps).
3. On the remote, press **1 2 3 4 5** (with the on-screen number pad if your remote has no digits).
4. Switch **Developer mode** to **On**, enter your **computer's IP address**, and confirm.
5. Restart the TV: hold the power button until the logo appears.

Note the TV's own IP address (Settings → General → Network → Network Status → IP Settings).

## 2. Install Tizen Studio

1. Download **Tizen Studio with IDE installer** from <https://developer.tizen.org/development/tizen-studio/download>.
2. Install it, then open the **Package Manager**:
   - *Main SDK*: keep the default **Tizen SDK tools**;
   - *Extension SDK*: install **TV Extensions** and **Samsung Certificate Extension**.

The command-line tool is then at `~/tizen-studio/tools/ide/bin/tizen` (Windows: `C:\tizen-studio\tools\ide\bin\tizen.bat`)
and the device bridge at `~/tizen-studio/tools/sdb`. Adding both folders to your `PATH` is convenient.

## 3. Connect to the TV

```bash
sdb connect <TV-IP>
sdb devices        # shows the TV, e.g.  192.168.1.50:26101   device   QE55Q80TAT
```

If it fails: check that developer mode shows your computer's IP, and that both are on the same network.

## 4. Create a Samsung certificate (once)

1. In Tizen Studio: **Tools → Certificate Manager → +**.
2. Choose **Samsung**, then device type **TV**.
3. Create a profile name, e.g. `termtv`.
4. **Author certificate**: create a new one (name + password), then sign in with your Samsung account.
5. **Distributor certificate**: privilege level **Public**. The connected TV's **DUID** is added automatically;
   to install on other TVs later, add their DUIDs here.
6. Finish. The profile becomes the active one.

## 5. Build, sign and install

```bash
git clone https://github.com/b0tmtl/termtv.git
cd termtv
npm install
TIZEN_PROFILE=termtv npm run package          # produces build/TermTV.wgt
tizen install -n build/TermTV.wgt -t <device-name-from-sdb-devices>
```

(Windows PowerShell: `$env:TIZEN_PROFILE="termtv"; npm run package`.)

TermTV now appears in **Apps** on the TV. To update, pull the latest code and run the last two commands again.

## Troubleshooting

| Problem | Fix |
|---|---|
| `install failed: certificate` | The TV's DUID isn't in your distributor certificate: add it in Certificate Manager and package again. |
| `sdb connect` times out | Developer mode is off or points to another IP; restart the TV after changing it. |
| App starts then closes | Check `sdb dlog | grep -i termtv` and open an issue with the output. |
| A channel won't play | Settings → Player: switch the engine to HTML5, or the live format to HLS (.m3u8). |
| Video plays but stutters | Try the other player engine; some streams are just too heavy for older TVs. |

## Testing without a real provider

Run the mock provider on your computer (`npm run mock`), then in TermTV add an Xtream source with
server `http://<computer-IP>:8090`, user `demo`, password `demo`. The live channels are H.264 test
patterns, which the TV's player can decode.
