# Desktop app icon

`../icon-source.png` is the approved StarNet desktop icon master (2026-09-23):
the original hollow four-point amber star on a borderless circular CRT surface,
with transparency outside the circle. Preserve this artwork when exporting sizes.

Regenerate the platform assets from the repository root with:

```sh
npm run desktop:icon
```

The Tauri bundle uses the PNG sizes, `icon.ico` (Windows application and NSIS
installer), and `icon.icns` (macOS). The tray uses Tauri's default window icon.
The command also refreshes the existing ancillary platform sizes.

Source SHA-256: `4ea401f76fde4cc918935c65b0167a750544a53654a0ce6d86e3ac1ec40a93c6`

The master is the owner-approved imagegen output, copied without pixel edits.
This changes the desktop icon only; the in-app wordmark is a separate asset.
