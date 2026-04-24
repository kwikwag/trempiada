## TODO

### UX

- [ ] `src/bot/ui.ts` - `renderProfile` should add 'Show picture' (if set) or 'Add picture' (if unset). When showing picture, have a 'Change picture' button.
- [ ] `src/bot/registration.ts` - `registerRegistrationHandlers` restart flow should just forget the gender, name and photo (upon confirmation) so that they may be picked up as a later flow (request/offer a ride)
- [ ] User should be able to change their active car also in the My Profile screen

### Test coverage

- [ ] `src/services/identity/profile-face.ts` - `validateAndCropPhoto` should be covered for zero-face, multi-face, occluded, low-brightness, low-sharpness, bad-pose, and successful crop cases using realistic image fixtures.
- [ ] `src/bot/handlers/profile-photo.ts` - `tryTelegramProfilePhoto` / `processPhotoCandidate` should be covered for Telegram download failure, invalid-face rejection, cropped-photo send failure, and Telegram-profile-photo fallback to manual upload.
- [ ] `web/src/App.tsx` - bootstrap flow should be covered for missing token, bootstrap failure, detector error, and complete-state return-to-Telegram fallback behavior.
- [ ] `infra/src/bot-policy.ts` - `createBotIdentityPolicy` should be covered for the exact Rekognition, STS AssumeRole, and DynamoDB PutItem statements emitted for the bot policy document.

### More info requried

- [ ] Profile photo quality: send the photo to a face-crop service — if no face is detected, loop back and ask again. Show the cropped face and ask the user to confirm it's them, change the photo, or skip. If they skip, warn that having no photo reduces their trust score and makes drivers/riders less likely to accept them. Photo is stored as a Telegram file ID and only shared with the matched party (driver↔rider) when a match is confirmed, not before.
- [ ] OAuth flows for social verification (Facebook, LinkedIn, Google)
- [ ] "Share ride" web page for safety
- [ ] Admin dashboard for dispute resolution and account suspension management
- [ ] Push notification tuning
- [ ] Rate limiting and abuse detection refinements
- [ ] Hebrew localization
- [ ] `registerInRideHandlers` / cancellation flow: if multi-seat ride offers are added, cancelling one matched rider should reopen or revise the remaining offer instead of cancelling the whole ride.
- [ ] Vouch system: only allow users into the app from an invite link they receive from another user. The invite is one-time. Users are allowed to invite N people per time window to throttle growth and prevent abuse. The users are required to vouch for the people they invite. This way we obtain a trust graph network.
- [ ] Add readme on how to update licenses.db - download the databases at:
  1. https://data.gov.il/he/datasets/ministry_of_transport/private-and-commercial-vehicles/053cea08-09bc-40ec-8f7a-156f0677aff3
  2. https://data.gov.il/he/datasets/ministry_of_transport/degem-rechev-wltp/142afde2-6228-49f9-8a29-9b6c3a0cbe40

  And use `python3 scripts/build_licenses_db.py` to create an updated database.
