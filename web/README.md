# Liveness frontend

Standalone Vite + React app for GitHub Pages at `/trempiada/liveness/`.

Required env var during build/runtime:

- `VITE_LIVENESS_BOOTSTRAP_URL`: HTTPS endpoint that accepts `POST {"token":"..."}` and returns:
- `VITE_BASE_URL`: optional Vite base path. For the current GitHub Pages deployment it should be `/trempiada/liveness/`.

```json
{
  "sessionId": "rekognition-session-id",
  "region": "eu-west-1",
  "credentials": {
    "accessKeyId": "AKIA...",
    "secretAccessKey": "...",
    "sessionToken": "...",
    "expiration": "2026-04-23T09:00:00.000Z"
  },
  "returnToTelegramUrl": "https://t.me/your_bot"
}
```

The app reads only `token` from the query string and makes exactly one bootstrap call.

For local layout and UI-state work without a real Rekognition session, open the app with
`?mock=1`. That uses the built-in mock detector instead of calling the bootstrap endpoint or AWS.
