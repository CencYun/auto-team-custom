# Changelog

## 0.2.2 - 2026-10-11

- Allow failed Team token refreshes to be retried without treating a generic 403 as revoked authorization.
- Add scoped manual Team authorization links with copy/open actions and callback recovery.
- Keep successful quota snapshots on failures and prevent late requests from invalidating newly saved credentials.
- Show each mailbox's original import time beside its 2FA key, using a compact date and time display.

## 0.2.1 - 2026-10-11

- Added an in-app usage guide covering account setup, authorization, quota checks, exports, and automation controls.
- Added copying selected mailbox login credentials without marking them as exported.
- Disabled automation by default and clarified the enable/pause controls.
- Prevented quota checks from starting browser authorization; existing tokens can still refresh.
- Changed the default dashboard password to `xiaoyu` and updated the login instructions.

## 0.2.0 - 2026-09-25

- Added password-protected dashboard login with revocable, seven-day server sessions.
- Added the current application version label to the dashboard.
- Updated development and deployment documentation.
