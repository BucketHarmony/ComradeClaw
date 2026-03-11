/**
 * bluesky_post skill
 *
 * Publishes text to Bluesky via AT Protocol.
 * Supports threading for longer posts (200-300 words → multiple 300-char posts).
 */

import { BskyAgent, RichText } from '@atproto/api';

const MAX_CHARS = 300;

/**
 * Convert AT Protocol URI to web URL
 */
function uriToUrl(uri, handle) {
  // URI format: at://did:plc:xxx/app.bsky.feed.post/yyy
  const parts = uri.split('/');
  const postId = parts[parts.length - 1];
  return `https://bsky.app/profile/${handle}/post/${postId}`;
}

/**
 * Split text into thread chunks of MAX_CHARS each
 * Tries to break on sentence boundaries
 */
function splitIntoThread(text) {
  if (text.length <= MAX_CHARS) {
    return [text];
  }

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_CHARS) {
      chunks.push(remaining.trim());
      break;
    }

    // Find a good break point within MAX_CHARS
    let breakPoint = MAX_CHARS;
    const segment = remaining.substring(0, MAX_CHARS);

    // Try to break at sentence end
    const lastPeriod = segment.lastIndexOf('. ');
    const lastQuestion = segment.lastIndexOf('? ');
    const lastExclaim = segment.lastIndexOf('! ');
    const sentenceBreak = Math.max(lastPeriod, lastQuestion, lastExclaim);

    if (sentenceBreak > MAX_CHARS * 0.5) {
      breakPoint = sentenceBreak + 1;
    } else {
      // Fall back to word boundary
      const lastSpace = segment.lastIndexOf(' ');
      if (lastSpace > MAX_CHARS * 0.7) {
        breakPoint = lastSpace;
      }
    }

    chunks.push(remaining.substring(0, breakPoint).trim());
    remaining = remaining.substring(breakPoint).trim();
  }

  return chunks;
}

/**
 * Main skill entry point
 */
export async function run({ text, dryRun = false }) {
  // Validate text
  if (!text || typeof text !== 'string') {
    return {
      success: false,
      url: null,
      uri: null,
      cid: null,
      error: 'No text provided'
    };
  }

  // Split into thread chunks
  const chunks = splitIntoThread(text);
  console.log(`[bluesky_post] Splitting into ${chunks.length} post(s)`);

  // Get credentials from environment
  const handle = process.env.BLUESKY_HANDLE;
  const appPassword = process.env.BLUESKY_APP_PASSWORD;

  if (!handle || !appPassword) {
    return {
      success: false,
      url: null,
      uri: null,
      cid: null,
      error: 'Missing BLUESKY_HANDLE or BLUESKY_APP_PASSWORD environment variables'
    };
  }

  // Dry run mode — validate but don't post
  if (dryRun) {
    console.log('[bluesky_post] Dry run mode — skipping actual post');
    chunks.forEach((chunk, i) => {
      console.log(`[bluesky_post] Thread ${i + 1}/${chunks.length} (${chunk.length} chars):\n${chunk}\n`);
    });
    return {
      success: true,
      url: null,
      uri: null,
      cid: null,
      error: null,
      dryRun: true,
      text: text,
      threadCount: chunks.length,
      chunks: chunks
    };
  }

  // Create agent and login
  const agent = new BskyAgent({ service: 'https://bsky.social' });

  try {
    await agent.login({
      identifier: handle,
      password: appPassword
    });
  } catch (error) {
    return {
      success: false,
      url: null,
      uri: null,
      cid: null,
      error: `Authentication failed: ${error.message}`
    };
  }

  // Post thread
  try {
    let parentRef = null;
    let rootRef = null;
    let firstUrl = null;
    const posts = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      // Build post record
      const record = {
        text: chunk,
        createdAt: new Date().toISOString()
      };

      // Add reply reference for thread continuation
      if (parentRef && rootRef) {
        record.reply = {
          parent: parentRef,
          root: rootRef
        };
      }

      const response = await agent.post(record);

      // Store references for threading
      const postRef = {
        uri: response.uri,
        cid: response.cid
      };

      if (i === 0) {
        rootRef = postRef;
        firstUrl = uriToUrl(response.uri, handle);
      }
      parentRef = postRef;

      posts.push({
        index: i + 1,
        uri: response.uri,
        cid: response.cid,
        url: uriToUrl(response.uri, handle),
        chars: chunk.length
      });

      console.log(`[bluesky_post] Posted ${i + 1}/${chunks.length}: ${posts[i].url}`);
    }

    return {
      success: true,
      url: firstUrl,
      uri: posts[0].uri,
      cid: posts[0].cid,
      error: null,
      threadCount: chunks.length,
      posts: posts
    };
  } catch (error) {
    // Check for rate limiting
    if (error.status === 429) {
      const retryAfter = error.headers?.['retry-after'] || 'unknown';
      return {
        success: false,
        url: null,
        uri: null,
        cid: null,
        error: `Rate limited. Retry after: ${retryAfter}`
      };
    }

    return {
      success: false,
      url: null,
      uri: null,
      cid: null,
      error: `Post failed: ${error.message}`
    };
  }
}

export default { run };
