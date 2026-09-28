---
title: Saved chat generation
---

The LocalAlice Chat page starts a saved generation on the LocalAI controller.
You can navigate away, reload, or open the instance on another device while a
normal chat or server-side MCP request continues. The page reads saved snapshots
about every 700 ms. Stop cancels the server request and retains partial output.
Browser-connected MCP tools still require their browser page to remain open.

Jobs are saved under `DATA_PATH/ui/generations`; credentials are never written
to these files. After a controller restart, unfinished jobs are marked interrupted
and retain the last checkpoint. They are not automatically re-run. Refreshing a
webpage does not restart a job. PC1/PC2 placement follows the existing controller
configuration.

The UI uses authenticated `POST /api/chats/generate` (an idempotent request ID,
chat snapshot, OpenAI chat request and supported endpoint) and
`POST /api/chats/generations/:id/cancel`. Results are included in `GET /api/chats`.
Jobs use the same authenticated inference handler and model permissions as direct
chat requests. Cancellation is restricted to the submitting account. Conversation
storage remains shared across accounts on this instance, as before.

Output is capped at 4096 tokens. GPT-OSS requests default to low reasoning effort.
A repeated thinking passage or 24,000 characters of thinking stops the job with
a visible explanation; this is a guard, not a guarantee that every model loop is
detectable. Raw thinking is kept separate and is not fed back as assistant text.

Compact context is available in Chat settings after more than eight text turns.
It summarizes older turns, retains the latest eight and archives the originals
in the chat data. Compaction is manual and summaries can omit detail. It does not
increase a model's configured context window.
