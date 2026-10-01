# Playback API

`POST /api/play-vibe` generates a mix, replaces the target Music Assistant queue,
and starts playback. Each call generates a fresh mix from the selected vibes.

## Authentication

In Sole, open **Manage → API keys**, create an **external playback** key, and copy
the secret. Send it as `Authorization: Bearer <key>`. An existing
`PLAYBACK_API_KEY` environment credential also works. Worker keys do not.

Send JSON with `Content-Type: application/json`. The playback key grants this POST
route; it does not grant browser access or access to the settings APIs.

## Choose the mix

| JSON body | Plays |
|---|---|
| `{}` | The saved picks from **Vibe → Mix**. Save those picks first. |
| `{"useSchedule": true}` | The enabled slot matching Sole's current local hour. Falls back to saved picks when no slot matches. |
| `{"scheduleId": 3}` | A specific enabled, nonempty schedule slot, regardless of the current hour. |
| `{"clusterIds": [2, 7]}` | Those vibe IDs for this request, without replacing the saved picks. |

When combined, `scheduleId` takes priority over `useSchedule`, which takes priority
over `clusterIds`. Use one selection method per request.

The home page's temporarily highlighted schedule card is not a saved API selection.
Use `scheduleId` to play that particular slot. Selecting a schedule does not itself
start playback automatically; a button or automation must call the API.

Schedules use **Sole's server timezone**, not the Home Assistant timezone. Hours
can wrap overnight; `22–6` covers late evening through early morning. Equal start
and end hours cover the whole day.

```sh
curl --fail-with-body -X POST https://sole.example.com/api/play-vibe \
  -H "Authorization: Bearer $SOLE_PLAYBACK_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"useSchedule":true}'
```

## Choose the playback device

The default target is configured under **Manage → Playback device**. Choose a
speaker or sync group, or **Automatic** to follow active playback. The selection
is global and persists across restarts. Until a UI selection is saved, an existing
`MA_PLAYER_NAME` environment setting remains the default.

For one call, append `?playerId=<Music Assistant player ID>`:

```sh
curl --fail-with-body -X POST \
  'https://sole.example.com/api/play-vibe?playerId=syncgroup_example' \
  -H "Authorization: Bearer $SOLE_PLAYBACK_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"useSchedule":true}'
```

The override does not change the saved default. Use a Music Assistant **player ID**,
not a Home Assistant entity ID such as `media_player.living_room`. While logged
into Sole, `GET /api/playback-settings` lists player IDs and friendly names. That
GET requires a browser session, not a playback key. URL-encode the ID if necessary.

::: info Availability
Saved-picks and schedule playback are available in v0.1.3. The UI device selector
and `playerId` override are development changes requiring migration
`0019_playback_settings`; they are not included in v0.1.3.
:::

## Responses

Successful playback returns HTTP 200:

```json
{"success": true, "tracks": [{"uri": "library://track/123"}]}
```

Track objects include additional metadata. Error responses include an `error`
message. HTTP 401 means a missing, expired, revoked, or wrong-scope credential;
400 means an invalid selection or player override; 500 means generation,
track validation, or playback failed. Read the response body for the reason.

For dashboard buttons and automations, see [Home Assistant](/guides/home-assistant).
