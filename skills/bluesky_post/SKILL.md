# bluesky_post

Publish text to Bluesky via AT Protocol.

## Trigger

Post cycle after generation, or manual via `post now` command.

## Inputs

```json
{
  "text": "string (max 300 chars)",
  "dryRun": "boolean (if true, skip actual post — used by draft command)"
}
```

## Outputs

```json
{
  "success": "boolean",
  "url": "string or null (Bluesky post URL)",
  "uri": "string or null (AT Protocol URI)",
  "cid": "string or null (content identifier)",
  "error": "string or null"
}
```

## Implementation

Uses `@atproto/api` package:

```javascript
import { BskyAgent } from '@atproto/api'

const agent = new BskyAgent({ service: 'https://bsky.social' })
await agent.login({ identifier: handle, password: appPassword })
const response = await agent.post({ text })
```

## Character Limit

300 characters. The generation step enforces this; this skill validates and rejects if exceeded.

## Environment

- `BLUESKY_HANDLE`: Account handle (e.g., `comradeclaw.bsky.social`)
- `BLUESKY_APP_PASSWORD`: App password from Bluesky settings

## Error Handling

- Auth failure: Return error, trigger operator notification
- Rate limit: Return error with retry-after if available
- Network failure: Return error, do not retry automatically
- Text too long: Return error, do not truncate

## Dry Run Mode

When `dryRun: true`, validate inputs but skip actual posting. Used by `draft` operator command for voice checks during bringup.
