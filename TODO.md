## TODO

### Major features

- [ ] Geocoding service (text addresses → coordinates)
- [x] Waze link parsing for route import
- [ ] OAuth flows for social verification (Facebook, LinkedIn, Google)
- [ ] "Share ride" web page for safety
- [ ] Admin dashboard for dispute resolution and account suspension management
- [ ] Push notification tuning
- [ ] Rate limiting and abuse detection refinements
- [ ] Hebrew localization

### Minor features and bugs

- [ ] Posting a drive while waiting for a ride, asking for a ride while a drive is posted, or requesting more than one ride or offering more than one ride should overwrite the last status. This should be reflected in the subsequent message allowing the user to cancel (`Here's your ride` already has the option to cancel so we can just add some more information to that message, but we might need to add it to the `/ride` flow). prompt should indicate that it will replace the current drive.
- [ ] `/status` should indicate if a ride is currently offered or requested, not only matches. Similarly `/cancel` should cancel the match if there is one active - otherwise it should cancel the current drive being offered or ride being requested - also specifying a reason (though the set of reasons is different than those when cancelling a match). When cancelling a match, repeat the current state of the user (ride being requested or drive being offered) and ask them if they want to revise or cancel it. Try to re-use code here (DRY).

## Ideas

- Vouch system: only allow users into the app from an invite link they receive from another user. The invite is one-time. Users are allowed to invite N people per time window to throttle growth and prevent abuse. The users are required to vouch for the people they invite. This way we obtain a trust graph network.
- Add readme on how to update licenses.db - download the databases at:
  1. https://data.gov.il/he/datasets/ministry_of_transport/private-and-commercial-vehicles/053cea08-09bc-40ec-8f7a-156f0677aff3
  2. https://data.gov.il/he/datasets/ministry_of_transport/degem-rechev-wltp/142afde2-6228-49f9-8a29-9b6c3a0cbe40

  And use `python3 scripts/build_licenses_db.py` to create an updated database.
  - Remove user profile pic upload. Use telegram's if possible
  - Don't use slash command - instead show buttons
