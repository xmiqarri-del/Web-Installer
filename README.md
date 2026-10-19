# Car_DisplayZ WebInstaller

A browser-based tool to install the **Car_DisplayZ** application on Android car head units, fix its permissions, **install any other app via APK**, and do so **completely without needing `adb.exe` on a computer**. The page communicates with the head unit over USB using WebUSB.

🌐 **Live Demo:** [https://xmiqarri-del.github.io/Web-Installer/](https://xmiqarri-del.github.io/Web-Installer/)

---

## 🚀 What It Does

- **APK Installation**: Choose the app file downloaded from GitHub; the page pushes it to the head unit, installs it, and reads back the actually installed version number for verification.
- **Custom APK Installation**: The "Select APK for another app" button accepts any `.apk` file. The tool automatically detects the package name of newly installed apps and populates the package field. No special permissions are pre-granted.
- **Home Launcher (Optional)**: In the Advanced Tools section, sets an app as the head unit's home launcher via `cmd package set-home-activity`, after validating the `package/.Activity` component format.
- **Usage Guide**: An in-page section walking through steps from enabling USB debugging to troubleshooting.
- **Permissions Diagnostics**: Inspects version, floating button, bottom button bar, install from unknown sources, notifications, background execution, battery optimization exemption, and verifies that the app has been opened at least once (Android will not run apps after a reboot until opened manually, nor after a force-stop). A dedicated fix button opens the app directly on the screen.
- **Auto or Individual Fixes**: Modifies only what is necessary and verifies after each fix. Fixes never delete apps or user data, and they do not touch other accessibility services.
- **User App Uninstallation**: Lists user-installed apps on the head unit (excluding system apps). Select what you want to remove, and delete them along with their data and settings after confirmation. The local APK file on your computer remains unaffected.
- **Error Decoder**: Explains common error messages from ADB and the installation process.

---

## ⚙️ ADB Factory Menu Configuration

The **"ADB Configuration"** section allows selecting firmware versions `3.30–3.35` or `3.36–3.37+`, time zone, and car clock offset. It calculates a 6-digit code and updates the local clock countdown. Older firmware displays a static connection code, while newer firmware displays a dynamic rolling code.

> **Important Note:** The attached `WebInstaller-master.zip` archive does not contain a license file, and testing notes confirm that code values have not been verified on a real vehicle. Therefore, its code, APK, or bundled ADB library were not copied; an independent module was built in `src/codegen.mjs` and integrated into the `index.html` build. The value `391819` matching an image example does not guarantee it will work on a real vehicle. Match the time zone, clock, and software version yourself, and do not modify engineering settings you do not understand. The website does not open menus or enable ADB automatically.

---

## 📋 Requirements

- **Google Chrome or Microsoft Edge** on a computer. (Firefox and Safari do not support WebUSB).
- A head unit running **Android 11 or newer**, with Developer Options and USB Debugging enabled.
- A **data-capable USB cable** (charging-only cables will not work).
- An **active internet connection** when opening the page to load the ADB library from jsDelivr with pinned stable versions.

---

## 🕹️ Usage

1. Open `index.html` in Chrome or Edge.
2. If ADB is not enabled, open **ADB Configuration**, match your firmware version, time zone, and car time, then follow the manual steps. Calculated codes are directional and unverified on physical hardware.
3. Click **Connect Head Unit**, select your device from the browser prompt, accept the USB debugging prompt on the car screen, and check "Always allow".
4. Click **Download APK** (opens in a new tab) to download `Car_DisplayZ-v1.1.11.apk` from GitHub.
5. Click **Install APK on Screen** and select the file. If the file doesn't match the official release version, the page will prompt you before proceeding.
6. Click **Run Permissions Diagnostics**, then **Auto-Fix All Issues** if necessary.
7. To uninstall an app: Click **Refresh List** in Section 3, select the apps, click **Uninstall Selected from Screen**, and confirm.
8. To install another app: Click **Select APK for
