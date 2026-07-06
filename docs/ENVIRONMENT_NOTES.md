# Local Environment Notes

## Current Resource Check

- `C:\` free space: about 1.88 GB.
- `D:\` free space: about 87.46 GB.
- `E:\` free space: about 142.4 GB.
- Available memory during check: about 1.37 GB.
- Existing npm cache on `C:\Users\sunlixin\AppData\Local\npm-cache`: about 3.1 GB.

The previous `npm install mammoth pdf-parse` failure was caused by `ENOSPC` on the system/npm-cache drive, not by project code. The project itself is on `E:\`, which has enough space.

## Adjusted Execution Flow

1. Keep the lightweight built-in Word/PDF adapters in place for now. They use Node built-ins and do not require extra npm dependencies.
2. Project npm cache is redirected to `E:\work\aiExam\.npm-cache` via `.npmrc`.
3. Avoid running broad dependency installs while `C:\` free space is low.
4. For future installs, prefer:

```powershell
$env:TEMP='E:\work\aiExam\tmp'
$env:TMP='E:\work\aiExam\tmp'
npm install <package>
```

5. Re-run `npm run build` after dependency or adapter changes. The latest build passed after avoiding the failed dependency install path.

## Optional Cleanup

The largest reclaimable cache found is:

```powershell
C:\Users\sunlixin\AppData\Local\npm-cache
```

Only clean it when acceptable for the local development machine:

```powershell
npm cache clean --force
```

This command is intentionally not run automatically because it changes global user cache state.
