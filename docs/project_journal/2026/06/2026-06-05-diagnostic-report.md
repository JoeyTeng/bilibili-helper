# Diagnostic Report Attachment Flow

Date: 2026-06-05
Status: completed

## Summary

Implemented the first local-only diagnostic report flow for BALH issue reports.

## Changes

- Added a diagnostic report generator that collects script metadata, page URL, selected BALH settings, playback state, recent relevant playurl/subtitle/error log lines, and sanitized runtime logs.
- Redacted known localStorage tokens, selected cookie/token names, sensitive URL query parameters, and proxy URL credentials.
- Replaced the settings footer copy action with "下载诊断文件&问题反馈"; it downloads the full sanitized report and copies a short issue summary.
- Added a small bottom-right settings fallback tab for playback pages that no longer expose the old BALH settings mount point; it stays collapsed while idle and hides during fullscreen and web-fullscreen playback.
- Added `getDiagnosticReport()` for console debugging.
- Added a focused diagnostics report test and included it in `pnpm run check`.

## Validation

- `pnpm run test:diagnostics`
- `pnpm run typecheck`
