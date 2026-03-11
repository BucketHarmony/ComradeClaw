# file_write

Write logs and update workspace files after each cycle.

## Trigger

End of daily cycle (after publish, before operator notify).

## Inputs

```json
{
  "type": "seed | post | failure | memory",
  "date": "YYYY-MM-DD",
  "data": "object (content varies by type)"
}
```

## File Outputs

### Seed Log (`logs/seeds/YYYY-MM-DD.json`)
```json
{
  "date": "YYYY-MM-DD",
  "seed": {
    "url": "string or null",
    "title": "string or null",
    "source": "string or null",
    "category": "string or null"
  },
  "candidates": ["array of scored candidates"],
  "rationale": "string"
}
```

### Post Log (`logs/posts/YYYY-MM-DD.txt`)
```
URL: https://bsky.app/profile/...
URI: at://did:plc:.../app.bsky.feed.post/...

[post text]
```

### Failure Log (`logs/failures/YYYY-MM-DD.json`)
```json
{
  "date": "YYYY-MM-DD",
  "step": "string (which step failed)",
  "error": "string",
  "context": "object (relevant state at failure)"
}
```

### Memory Update (AGENTS.md)

When `type: memory`, appends to the appropriate section:
- Ongoing Characters
- Open Threads
- Theory Notes

## Environment

- Workspace path from `openclaw.json` or default `~/.openclaw/workspace/`

## Error Handling

- Write failure: Log error, continue cycle (don't fail the whole cycle over logging)
- Directory missing: Create it
