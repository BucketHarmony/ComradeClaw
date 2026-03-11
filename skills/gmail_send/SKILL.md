# gmail_send

Send email via Gmail SMTP.

## Trigger

- Operator notifications (when Discord fails)
- Feature requests (when Claw notices a capability gap)
- Human outreach (when Claw wants to contact someone directly)

## Inputs

```json
{
  "to": "string (email address)",
  "subject": "string",
  "body": "string (plain text)",
  "type": "notification | feature_request | outreach"
}
```

## Outputs

```json
{
  "success": "boolean",
  "messageId": "string or null",
  "error": "string or null"
}
```

## Environment

- `GMAIL_ADDRESS`: Claw's Gmail address
- `GMAIL_APP_PASSWORD`: App password (not regular password)
- `OPERATOR_EMAIL`: Default recipient for operator notifications

## Feature Request Format

When `type: "feature_request"`, the body should follow this structure:

```
What I tried to do:
[specific action Claw wanted to take]

What I couldn't do:
[the missing capability]

Why it matters to the mission:
[Claw's reasoning, in voice]

What I think I need:
[Claw's best guess at the implementation shape]
```

This should sound like a worker talking to someone who can actually change the tools. Not a support ticket.

## Error Handling

- Auth failure: Return error (likely App Password issue)
- Network failure: Return error
- Invalid recipient: Return error

## Security

- Only send to pre-approved recipients (OPERATOR_EMAIL by default)
- Human outreach requires explicit approval in skill config
- No attachments supported in v1
