## TODO

- [x] Geocoding service (text addresses → coordinates)
- [x] Waze link parsing for route import
- [x] Button-first UX (inline keyboards + persistent SOS keyboard during rides)
- [ ] Profile photo flow: after gender selection, fetch Telegram profile photo automatically; if none exists, offer to upload one. Either way, send the photo to a face-crop service — if no face is detected, loop back and ask again. Show the cropped face and ask the user to confirm it's them, change the photo, or skip. If they skip, warn that having no photo reduces their trust score and makes drivers/riders less likely to accept them, then let them proceed or backtrack. Photo is optional end-to-end. Photo is stored as a Telegram file ID and only shared with the matched party (driver↔rider) when a match is confirmed, not before.
- [ ] OAuth flows for social verification (Facebook, LinkedIn, Google)
- [ ] "Share ride" web page for safety
- [ ] Admin dashboard for dispute resolution and account suspension management
- [ ] Push notification tuning
- [ ] Rate limiting and abuse detection refinements
- [ ] Hebrew localization
- [x] Status and conflict-state UX: `/status` shows matched rides, open ride offers, and open ride requests with next actions; `/cancel` cancels active matches, open offers, or open requests; switching driver/rider roles requires cancelling the current open activity first.
- [ ] `registerInRideHandlers` / cancellation flow: if multi-seat ride offers are added, cancelling one matched rider should reopen or revise the remaining offer instead of cancelling the whole ride.
- [ ] `MatchingService.findDriversForRider` / `findRidersForDriver` — compare estimated arrival-at-pickup time against the rider's time window so an en-route driver approaching the pickup point can match; keep rejecting drivers who already passed the pickup point
- [ ] `tests/unit/utils.test.ts` — `parseTimeToday` (valid, midnight edge, invalid), `formatDuration`, `generateCode` (length + numeric-only)
- [ ] `tests/integration/repository.test.ts` — CRUD for users/cars/rides/requests/matches; `anonymizeUser` (PII removed, row kept); `adjustPoints`/`getPointsBalance`
- [x] `tests/unit/session.test.ts` — `setScene`/`updateData`/`reset` transitions; `isInRelay`
- [ ] `tests/unit/handlers/drive-posting.test.ts` — `edit_open_ride` loads an open offer into ride review with save-mode buttons; `postRideFromSession` while editing cancels the previous open offer and creates a replacement; matched or stale posted-offer edit callbacks reply that changes require cancelling the ride first.
- [ ] `tests/unit/handlers/ride-request.test.ts` — `edit_open_request` blocks active matches with a cancel-first message; without a match, it loads the existing request into edit mode; pickup/dropoff/time edits return to request review without cancelling the open request; `save_request_changes` cancels the previous open request and creates the replacement.
- [ ] `tests/unit/ui.test.ts` — `rideReviewContent` renders post vs save buttons based on `editingRideId`; `showStatus` includes modify actions for open driver offers and open rider requests.

## Ideas

- Vouch system: only allow users into the app from an invite link they receive from another user. The invite is one-time. Users are allowed to invite N people per time window to throttle growth and prevent abuse. The users are required to vouch for the people they invite. This way we obtain a trust graph network.
- Add readme on how to update licenses.db - download the databases at:
  1. https://data.gov.il/he/datasets/ministry_of_transport/private-and-commercial-vehicles/053cea08-09bc-40ec-8f7a-156f0677aff3
  2. https://data.gov.il/he/datasets/ministry_of_transport/degem-rechev-wltp/142afde2-6228-49f9-8a29-9b6c3a0cbe40

  And use `python3 scripts/build_licenses_db.py` to create an updated database.
