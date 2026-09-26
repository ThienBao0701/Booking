# 18 — Screenshot Storage (Phase 12)

Optional, local storage of screenshot **images**. Before Phase 12 the lab kept
only a capture record per screenshot; Phase 12 can keep the PNG as well.

## Privacy controls

| Control | Default | Where |
|---|---|---|
| Storage switch | **off** | Dashboard → Settings → *Screenshot storage* (`PUT /v1/screenshots/settings`), confirmation required to turn on |
| Retention | 30 days (1–365) | same; applied at service start, hourly, and on demand |
| Max image size | 5 MiB (64 KiB–20 MiB) | same; larger images are refused |
| Storage budget | 500 MiB (1 MiB–10 GiB) | same; uploads beyond it are refused (`507`) |
| Delete one image | — | Dashboard Screenshots page / `DELETE /v1/screenshots/:id` |
| Delete a session's images | — | Screenshots page with a session filter / `DELETE /v1/sessions/:id/screenshots` |

While storage is off nothing is uploaded, written or kept (the upload route
refuses before reading the body). Turning it off keeps existing images until
they are deleted or expire. Invalid settings files fail closed (storage stays
off, the reason is reported). Screenshots are still taken only on an explicit
operator action (extension popup) or by an explicit `captureScreenshot` replay
step.

## What is stored

`<LAB_DATA_DIR>/screenshots/<sha256>.png` (mode 0600, directory 0700,
content-addressed: identical images share one file) and a `screenshots` row:

| field | meaning |
|---|---|
| `id` | `shot_…` |
| `session_id`, `event_id` | the recorded session and its `SCREENSHOT` event (extension captures) |
| `run_id`, `step_id` | the replay run and step (replay screenshots) |
| `source` | `extension` \| `replay` |
| `sha256`, `bytes`, `width`, `height`, `mime` | computed by the service from the PNG |
| `ts` | capture time (the event's timestamp for extension captures) |
| `workflow` | the event's workflow label (or the replayed workflow) |
| `created_at` | when it was stored |

A file is deleted when no row references it any more (deletes, retention,
session purge + garbage collection).

## Binding and validation

An uploaded image is accepted only when:

- storage is on and the image is a PNG (signature + IHDR, plausible
  dimensions) within the size limit and the budget;
- the uploader's SHA-256 equals the digest of the bytes;
- it belongs to a recorded `SCREENSHOT` event **of that session**, with exactly
  the byte size recorded with the event; one image per event (retries are
  idempotent).

The event's own `sha256` field is masked at rest by the privacy redaction (a
64-character hex digest matches the opaque-token rule), which has been true
since Phase 2; the redaction is deliberately **not** relaxed. The service
therefore computes and stores the digest itself, and the dashboard shows it
for stored images.

## Flow

1. Extension popup → *Capture screenshot*: the capture record is recorded as
   before. If the service handshake reports storage on (and the image fits the
   limit), the service worker flushes the event and uploads the PNG
   (`POST /v1/screenshots`, bearer token, loopback only). The popup says
   whether the image was stored.
2. Replay `captureScreenshot` steps (browser controller): the engine's
   `onScreenshot` hook stores the PNG with `run_id` / `step_id` when storage is
   on (CLI with `--db`; a failed store never fails the step — it emits
   `step.warning`).
3. Dashboard → Screenshots: stored images as a grid (fetched with the token,
   shown from `blob:` URLs), capture records, storage usage, delete actions.

## API

| method | route | notes |
|---|---|---|
| GET/PUT | `/v1/screenshots/settings` | settings + usage; validated, persisted (0600) |
| POST | `/v1/screenshots` | `{ sessionId, eventId, sha256, dataBase64 }` → 201 |
| GET | `/v1/screenshots?session=&run=&from=&to=&limit=&offset=` | metadata |
| GET | `/v1/screenshots/:id` / `:id/image` | image: `image/png`, `nosniff`, `CSP: default-src 'none'; sandbox`, `no-store` |
| DELETE | `/v1/screenshots/:id`, `/v1/sessions/:id/screenshots` | |
| POST | `/v1/screenshots/retention` | apply retention now |

All routes need the token and pass the Host / Origin checks. The dashboard CSP
allows `blob:` for images only.
