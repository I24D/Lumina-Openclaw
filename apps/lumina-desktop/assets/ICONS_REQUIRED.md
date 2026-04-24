Place the following icon files in this folder before running `pnpm desktop:build`:

| File        | Size      | Platform |
|-------------|-----------|----------|
| icon.ico    | 256x256   | Windows  |
| icon.icns   | 512x512   | macOS    |
| icon.png    | 512x512   | Linux / fallback |

`icon.icns` is generated automatically on macOS during release builds from `icon.png`.

All icons should use the LUMINA brand mark.
The PNG is also used as the taskbar/dock icon in development mode.
