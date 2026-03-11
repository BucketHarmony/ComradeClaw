# operator_notify

Send Discord message to operator on cycle complete or failure.

## Trigger

- End of daily cycle (success or failure)
- Feature request generated
- Manual status request

## Inputs

```json
{
  "type": "success | failure | feature_request | status",
  "postUrl": "string or null",
  "postText": "string or null",
  "error": "string or null",
  "step": "string or null (which step failed)",
  "featureRequestSubject": "string or null",
  "nextScheduled": "ISO timestamp or null"
}
```

## Outputs

```json
{
  "success": "boolean",
  "messageId": "string or null",
  "error": "string or null",
  "fallbackUsed": "boolean (true if email fallback was used)"
}
```

## Message Formats

### Success
```
✓ Posted: [URL]
[first 200 chars of post]
```

### Failure
```
✗ Cycle failed at step: [step]
Error: [error message]
```

### Feature Request
```
📝 Feature request sent: [subject]
Check email for details.
```

### Status
```
Last cycle: [success/failure] at [timestamp]
Next scheduled: [timestamp]
Paused: [yes/no]
```

## Environment

- `DISCORD_BOT_TOKEN`: Bot token for Discord API
- `OPERATOR_DISCORD_USER_ID`: User ID to DM
- `DISCORD_GUILD_ID`: Guild for context

## Fallback

If Discord fails, attempt email via `gmail_send` skill with `type: notification`.

## Error Handling

- Discord API failure: Fall back to email
- Both fail: Log error, do not retry
