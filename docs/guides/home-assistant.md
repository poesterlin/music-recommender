# Home Assistant playback buttons

Home Assistant can call Sole's playback API using `rest_command`. Sole generates
the mix and plays it through Music Assistant; Home Assistant supplies the trigger.

## 1. Create a playback key

In Sole, open **Manage → API keys** and create an **external playback** key named
`Home Assistant`. Copy its secret. This is a Sole key, not your Music Assistant token.

In Home Assistant's `secrets.yaml`, add:

```yaml
sole_playback_url: "https://sole.example.com/api/play-vibe"
sole_playback_authorization: "Bearer REPLACE_WITH_YOUR_SOLE_PLAYBACK_KEY"
```

Replace the example hostname with a Sole address reachable from Home Assistant.
`127.0.0.1` inside a Home Assistant container refers to that container, not Sole.

## 2. Add two REST commands

Add these to Home Assistant's `configuration.yaml`. If you already have a
`rest_command:` section, merge the entries into it.

```yaml
rest_command:
  sole_play_picks:
    url: !secret sole_playback_url
    method: POST
    headers:
      Authorization: !secret sole_playback_authorization
    content_type: "application/json"
    payload: '{}'
    timeout: 120

  sole_play_schedule:
    url: !secret sole_playback_url
    method: POST
    headers:
      Authorization: !secret sole_playback_authorization
    content_type: "application/json"
    payload: '{"useSchedule":true}'
    timeout: 120
```

Restart Home Assistant after adding the integration. For later edits, reload
RESTful commands using `rest_command.reload`.

- **Play my picks** uses the picks saved in **Vibe → Mix**.
- **Play schedule** uses the enabled slot for Sole's current hour. When no slot
  matches, it uses the saved picks.

Both replace the target player's queue and start a newly generated mix.

## 3. Add dashboard buttons

Edit your dashboard, add a **Manual** card, and paste:

```yaml
type: grid
columns: 2
square: false
cards:
  - type: button
    name: Play my picks
    icon: mdi:music
    tap_action:
      action: perform-action
      perform_action: rest_command.sole_play_picks

  - type: button
    name: Play schedule
    icon: mdi:calendar-clock
    tap_action:
      action: perform-action
      perform_action: rest_command.sole_play_schedule
```

The playback key stays in Home Assistant's backend configuration, outside the
dashboard card.

## Other selections

To make the schedule button always play one slot, change its REST command payload:

```yaml
payload: '{"scheduleId":3}'
```

Use your schedule slot ID. While logged into Sole, `/api/vibe-schedules` returns
the schedules and their IDs. A disabled or missing slot is rejected.

To play explicit vibe IDs instead:

```yaml
payload: '{"clusterIds":[2,7]}'
```

To override the device, change the URL secret to include a Music Assistant player ID:

```yaml
sole_playback_url: "https://sole.example.com/api/play-vibe?playerId=syncgroup_example"
```

This changes the target for both commands above without changing Sole's default.
Use separate URL secrets if your buttons should target different rooms. The
`playerId` override is a development feature not present in v0.1.3; see
[API availability](/reference/playback-api#choose-the-playback-device).

## Automations

The same REST command can be an automation action:

```yaml
automation:
  - alias: "Play Sole morning schedule"
    triggers:
      - trigger: time
        at: "07:00:00"
    actions:
      - action: rest_command.sole_play_schedule
    mode: single
```

The trigger time uses Home Assistant's timezone; Sole chooses the slot using its
own server timezone. Align them if you want the hours to match.

## Check a failing call

Call the REST command from **Developer tools → Actions** when you intend to start
playback. REST commands expose the HTTP `status` and response `content` in their
action response. Check those against the [API response reference](/reference/playback-api#responses).

Reference: Home Assistant's [RESTful Command](https://www.home-assistant.io/integrations/rest_command/)
and [dashboard actions](https://www.home-assistant.io/dashboards/actions/) documentation.
