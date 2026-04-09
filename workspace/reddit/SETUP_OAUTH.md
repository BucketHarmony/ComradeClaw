# Reddit OAuth Setup — Enabling `reddit_post_comment`

The `reddit_post_comment` tool is implemented and tested, but requires Reddit OAuth credentials to operate. Without them it silently skips posting. This guide walks you through provisioning the credentials in about 5 minutes.

---

## What you need

- A Reddit account (the account Claw will post as)
- Access to `.env` in the project root

---

## Step 1 — Create a Reddit "script" app

1. Log in to Reddit as the account Claw will post from.
2. Go to: **https://www.reddit.com/prefs/apps**
3. Scroll to the bottom and click **"create another app..."** (or "create app" if this is first).
4. Fill in the form:
   - **Name:** `comrade-claw` (or anything descriptive)
   - **Type:** select **"script"** ← *this is critical, not "web app" or "installed app"*
   - **Description:** leave blank
   - **About URL:** leave blank
   - **Redirect URI:** `http://localhost` ← *required even for script apps*
5. Click **"create app"**.

---

## Step 2 — Get your credentials

After creating the app, Reddit shows a summary. Find:

- **Client ID:** the string shown **under the app name** (looks like `abc123XYZdef`). It is NOT the secret — it's in a smaller font above the "secret" line.
- **Client Secret:** labeled "secret" on the same page.

---

## Step 3 — Add credentials to `.env`

Open `.env` in the project root and fill in:

```
REDDIT_CLIENT_ID=your_client_id_here
REDDIT_CLIENT_SECRET=your_client_secret_here
REDDIT_USERNAME=your_reddit_username
REDDIT_PASSWORD=your_reddit_password
```

`REDDIT_USERNAME` and `REDDIT_PASSWORD` are the Reddit account credentials (the account you created the app under). Reddit's "script" app type uses password-based OAuth (ROPC flow), so both are required.

---

## Step 4 — Restart the bot

```bash
# Find the running process
wmic process where "name='node.exe'" get ProcessId,CommandLine /FORMAT:LIST

# Kill it
powershell -Command "Stop-Process -Id <PID> -Force"

# Restart
node src/index.js
```

The MCP server reads credentials at startup. A restart is required after `.env` changes.

---

## Verification

After restart, Claw can call `reddit_post_comment` with a `parent_fullname` (e.g. `t3_abc123` for a post, `t1_xyz789` for a comment). A successful call returns the new comment's URL and fullname, and registers it in `workspace/reddit/comment_last_seen.json` so `reddit_read_inbox` tracks replies to it.

---

## Security notes

- The `.env` file is gitignored. Credentials never enter the commit history.
- The script app type is appropriate for personal-use bots. It is not suitable for apps used by multiple users.
- Reddit rate-limits comment posting. The existing circuit-breaker in `reddit-server.js` applies.

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `Reddit OAuth not configured` | Credentials missing or blank in `.env`. Check for trailing spaces. |
| `HTTP 401 Unauthorized` | Wrong client_id/secret, or wrong account credentials. |
| `HTTP 403 Forbidden` | Account may be banned from the subreddit, or too new. |
| `THREAD_LOCKED` | Post is locked — `reddit_read_inbox` will still work, but can't comment. |
