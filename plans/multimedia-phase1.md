# Callboard multimedia support — Phase 1

Two stacked PRs:

- **PR1, backend serving.** A shared media-type table, HTTP Range on `/api/files/serve`, and new size caps. It adds no UI. After PR1, video already seeks and plays on Safari/iOS.
- **PR2, UI and tool.** The generic `file` card, video in the chat gallery, and updated `render_file` descriptions. It is based on PR1.

Read `.claude/CLAUDE.md` (wire compatibility, theming) before starting either PR.

## Current state (verified)

| Where | What |
|---|---|
| `backend/src/services/callboard-tools.ts:102` | `MIME_MAP` maps extension → `{mime, category}`. render_file rejects unknown extensions and files over 100 MB (`:347`). |
| `backend/src/routes/files.ts:7` | `ALLOWED_MIME` is a second copy of the same table. `/serve` always answers 200 with the whole body, has no Range support and a 100 MB cap, and sends `Content-Disposition: inline` plus sandbox headers. |
| `backend/src/routes/files.ts:124` | The URL proxy takes the served type from the extension (never from upstream), uses `fetchPublicUrl` (public addresses only, checked on every hop), and stops at 100 MB counted while streaming. |
| `backend/src/services/mcp-tool-registry.ts:24` | A third copy of the render_file description (the one shown in the UI). |
| `frontend/src/components/uiToolResult.ts:27` | Hard-codes `["image","audio","video","pdf"]`. Any other value makes it return `null`, and `ToolCallBubble` then renders the **generic tool bubble** (tool name, args, raw JSON result). The result is not dropped. |
| `frontend/src/components/MediaRenderer.tsx` | `RenderFileData.media_type` union. Only images join the gallery. Video/audio/PDF use `FullscreenFrame`. |
| `frontend/src/components/gallery/` | `ChatGallery` keeps a registry of DOM elements. `ImageLightbox` shows only `<img>`, with pinch, pan, double-tap and swipe gestures. `LightboxItem = {src, alt, caption, referrerPolicy}`. |
| `backend/src/routes/git.ts:132` | `/git/diff/file/raw` already serves any repo file's raw bytes to an authenticated client, with sandbox headers. This is precedent for PR2's download route. |

---

## PR1 — backend serving: shared table, Range, caps

### 1. One media-type table

**Location:** a new file, `backend/src/utils/media-types.ts`.

Why not `shared/`: only the backend maps extension → MIME. Putting the table in `shared/` would ship it to the frontend bundle and require `build:shared` for every format added. `shared/` gets only the **category** list the frontend validates against. That list lands in PR2 (see PR2 §1).

```ts
export type MediaCategory = "image" | "audio" | "video" | "pdf" | "captions";
export interface MediaTypeInfo { mime: string; category: MediaCategory }
export const MEDIA_TYPES: Readonly<Record<string, MediaTypeInfo>>; // key: lower-case ".ext"
export function mediaTypeForPath(p: string): MediaTypeInfo | undefined; // path.extname(...).toLowerCase()
```

**Contents.** Existing entries stay unchanged. New entries:

| ext | MIME | category |
|---|---|---|
| `.avif` | `image/avif` | image |
| `.apng` | `image/apng` | image |
| `.ico` | `image/vnd.microsoft.icon` | image |
| `.m4a` | `audio/mp4` | audio |
| `.opus` | `audio/ogg` (Ogg Opus) | audio |
| `.oga` | `audio/ogg` | audio |
| `.weba` | `audio/webm` | audio |
| `.m4v` | `video/mp4` (not Apple's `video/x-m4v`, so Chrome plays it) | video |
| `.ogv` | `video/ogg` | video |
| `.vtt` | `text/vtt` | captions |

These are deliberately left out and become a `file` card in PR2:

- `.mkv`, `.avi`, `.3gp`, `.heic`, `.jxl`, `.tif(f)`: browser playback is unreliable.
- `.html/.htm/.xhtml/.xml/.js/.mjs/.css/.json/.txt/.md`: script-capable or text formats that are never rendered inline from this route.

`captions` is a served type only. render_file does not render a `.vtt` file on its own: in PR1 it keeps returning "unsupported", and in PR2 it becomes a `file` card. Serving `.vtt` lets a later `<track src=/api/files/serve?...>` work, because the track is same-origin and needs no CORS.

**Consumers:**

- `callboard-tools.ts` removes `MIME_MAP` and calls `mediaTypeForPath`. A `captions` result is treated as unsupported for rendering in PR1.
- `files.ts` removes `ALLOWED_MIME` and uses `MEDIA_TYPES[ext]?.mime`.

**Guard test** (`backend/src/utils/media-types.test.ts`):

- Every MIME is in an allowlist of renderable-but-inert types, i.e. `image/*`, `audio/*`, `video/*`, `application/pdf`, `text/vtt`.
- No MIME is `text/html`, `application/xhtml+xml`, `*/xml`, `*javascript*` or `text/css`.
- `image/svg+xml` is the single script-capable exception. It is allowed only because of the sandbox CSP, and the test names it explicitly so adding a second exception fails.
- Every key is lower-case and starts with `.`.

### 2. HTTP Range for local files

**Implementation:** in `serveLocalFile`, after the existing checks (absolute path, no NUL, `realpath`, regular file, allowlisted type):

1. Set our headers first: `Content-Type` from the table, `Content-Disposition: inline`, and `setSandboxedContentHeaders(res)`.
2. Then call `res.sendFile(realPath, { dotfiles: "allow", acceptRanges: true, cacheControl: false, lastModified: true, etag: true })` with an error callback.

`send` (inside Express 4) should leave an existing `Content-Type` alone, because `SendStream.prototype.type` returns early when one is set. **Check this in `node_modules/send` first, and pin it with a test.** From the same call it handles:

- single and multi-range `206`
- `416` with `Content-Range: bytes */size`
- `If-Range`, ETag and `304`
- `HEAD`: Express routes HEAD to the GET handler, and `send` writes no body.

`dotfiles: "allow"` is required because the default `ignore` returns 404 for paths like `~/.cache/x.mp4`. `cacheControl: false` keeps today's behaviour of sending no `Cache-Control`.

- Fallback if `send` misbehaves in tests: parse with `range-parser` (already an Express dependency), serve one range only, and stream it with `createReadStream(realPath, {start, end})`. Either way, the behaviour below is the contract the tests pin.
- In the error callback, if headers are not yet sent, answer 404/500 as JSON. Otherwise call `res.destroy()`.

**Contract:**

| Request | Response |
|---|---|
| no `Range` | `200`, full body, `Accept-Ranges: bytes`, `Content-Length` |
| `bytes=0-99` | `206`, `Content-Range: bytes 0-99/N`, `Content-Length: 100` |
| `bytes=-100` / `bytes=100-` | `206`, suffix / open-ended range |
| `bytes=N-` (start ≥ size) | `416`, `Content-Range: bytes */N` |
| malformed (`items=0-1`, `bytes=x`) | `200` full body (RFC 9110: ignore an invalid Range) |
| `HEAD` | same status and headers, no body |

Every row, including 206, 416 and HEAD, keeps the `Content-Type` from the table plus `nosniff` and the sandbox CSP. The 416 body must not reflect the path.

### 3. Range through the URL proxy

Forward one **re-serialised** range upstream and relay the upstream `206`. The client's header string is never passed through.

1. Parse the client's `Range` with `range-parser` against a size of `Number.MAX_SAFE_INTEGER`, so that open-ended ranges parse.
   - Valid single range → send `Range: bytes=<start>-<end|empty>` upstream.
   - Multi-range or invalid → send no `Range` (equivalent to a full 200).
2. Upstream returns `206`:
   - Require `Content-Range` to match `^bytes \d+-\d+/(\d+|\*)$`. Otherwise return 502.
   - Relay `206` with `Content-Range`, the numeric `Content-Length` and `Accept-Ranges: bytes`.
   - Keep the extension-forced `Content-Type`, `inline` and the sandbox headers.
3. Upstream returns `416` → relay `416` (and `Content-Range` if it matches `^bytes \*/\d+$`) with an empty body.
4. Upstream ignores the range and returns `200` → behave as today. Do not send `Accept-Ranges`: the browser then treats the stream as unseekable, which is the honest answer.
5. Other statuses: 3xx is still followed by `fetchPublicUrl`. Any other non-2xx still returns 502.
6. Add `Range` to the `headers` passed to `fetchPublicUrl`. Check (and add a test) that the header survives each redirect hop it re-requests.

The public-address policy and the disconnect handling (`res.once("close")`) are unchanged. The 30 s timeout now covers connect + response headers only (across every redirect hop) and is cleared once headers arrive; the body is bounded by a 60 s idle timeout instead (changed in PR1 review, so a 100 MB window from a slow upstream is not cut off).

**Follow-up (deferred from PR1 review): forward `If-Range` upstream.** The proxy relays the upstream's `ETag` and `Last-Modified` on 200/206, but does not yet forward the client's `If-Range`. Until it does, a remote file that changes between two range requests can be stitched from two versions. To fix it: forward `If-Range` only if it matches the same safe ETag or IMF-fixdate pattern the relayed validators use, and treat an upstream 200 to a conditional range request as a full response (as today).

### 4. Caps

- **Local files: remove the cap.** Two reasons:
  - The 100 MB cap made sense when every request streamed the whole file, but `createReadStream` piping into `res` already applies backpressure and never buffers. A large file costs only disk bandwidth for the bytes actually requested.
  - The client already has full read authority over these paths through the agent. A cap only breaks legitimate long recordings (a 1080p screen recording reaches 100 MB in about 10 minutes).
  - Remove `MAX_SERVE_SIZE` from `serveLocalFile`, and remove render_file's `MAX_SIZE` check (`callboard-tools.ts:347`).
  - Note: `storage-service.ts`/`artifact-service.ts` describe "render_file's checks". They keep their own size limits; only the wording in their comments changes.
- **URL proxy: keep a cap, applied per response.**
  - `MAX_PROXY_BYTES = 100 MB` applies to each response body: a full 200, or each relayed 206.
  - A seek into a large remote video is a fresh, bounded request, so the cap no longer blocks remote video longer than 100 MB as long as the upstream supports ranges.
  - Keep both the advertised `Content-Length` check and the running count.
  - Reason to keep it: every proxied byte costs the daemon real network bandwidth on a fetch the agent chose, and the proxy is the open-ended endpoint.

### PR1 files

- `backend/src/utils/media-types.ts` (new)
- `backend/src/utils/media-types.test.ts` (new)
- `backend/src/routes/files.ts`
- `backend/src/services/callboard-tools.ts`: table and cap only. The description is unchanged until PR2.
- `backend/src/routes/served-content.http.test.ts`: extend it, or add `backend/src/routes/files.range.http.test.ts` using the same harness and local upstream server.
- Comment-only: `backend/src/services/storage-service.ts`, `backend/src/services/artifact-service.ts`

### PR1 tests

Run from the repo root.

```sh
npx vitest run backend/src/utils/media-types.test.ts backend/src/routes/served-content.http.test.ts backend/src/routes/files.range.http.test.ts
npm run lint:all
```

- **Local:** every row of the contract table above.
  - Check that `Content-Type`, `nosniff` and the CSP are present on 200, 206, 416 and HEAD.
  - A `.m4a` and an `.avif` are served with the new types.
  - An `.html` file → 415.
  - A file inside a dot-directory is served (proves `dotfiles: "allow"`).
  - A >100 MB **sparse** file (`ftruncate`, which uses no disk) answers 200 to HEAD and 206 to `bytes=104857600-104857699`.
- **Proxy**, using the test's local upstream through the existing `isAllowedAddress` seam:
  - The upstream sees a re-serialised `Range`.
  - Upstream 206 is relayed with `Content-Range`.
  - Upstream 200 without range support → 200 with no `Accept-Ranges`.
  - A malformed upstream `Content-Range` → 502.
  - Upstream 416 is relayed.
  - Multi-range from the client → no `Range` upstream.
  - `Range` survives a same-host redirect.
  - A per-response cap is hit mid-stream → the connection is destroyed.
  - The extension still decides `Content-Type` on a 206.
- **render_file:** a file over 100 MB is accepted, and `.m4v` returns `media_type: "video"`. Put these with the existing render_file tests, or add `callboard-tools.render-file.test.ts`.
- **Manual:**
  - Run `npm run dev` in the background.
  - Use render_file on an `.mp4` over 100 MB, seek in Chrome and Safari, and confirm 206 responses in devtools.
  - Check an iOS Safari tab if one is available.

No `shared/` changes, so `build:shared` is not needed.

---

## PR2 — generic file card, video in the gallery, descriptions

### 1. `media_type: "file"`

**Backend (`render_file`, local path only)**

- A regular file whose extension is not in `MEDIA_TYPES`, or is `captions`, returns:

  ```
  {type:"render_file", file_path, media_type:"file", mime_type:<descriptive>, display_mode, file_size, caption?, untrusted?…}
  ```

- `mime_type` is for **display only**. It comes from a small descriptive map in `media-types.ts` (`DESCRIPTIVE_MIME`: zip, tar, gz, json, csv, txt, md, html, docx, xlsx, …) and falls back to `application/octet-stream`. It never decides the served type.
- **URLs with an unknown extension keep returning an error** (see Q2).

**Backend (serving)**

- Add `GET /api/files/serve?path=…&download=1`, for any regular file and also for media.
  - Same path checks as now: absolute path, no NUL, `realpath`, `isFile`.
  - No type allowlist, but always:
    - `Content-Type: application/octet-stream`
    - `Content-Disposition: attachment; filename="<ascii-sanitised>"; filename*=UTF-8''<encodeURIComponent(name)>`
    - `nosniff` and the sandbox CSP
  - Range is supported through the same `sendFile` path, so downloads can resume.
- `download=1` with `url=` → 400. Phase 1 does not proxy arbitrary downloads.
- The filename comes from `path.basename(realPath)`. Strip `"`, `\`, CR/LF and control characters from the ASCII fallback.

**Shared**

In `shared/types/callboard-ui-tools.ts`, add:

```ts
export const RENDER_FILE_MEDIA_TYPES = ["image","audio","video","pdf","file"] as const;
export type RenderFileMediaType = typeof RENDER_FILE_MEDIA_TYPES[number];
```

- The backend `render_file` result type uses it, and so do `uiToolResult.ts` (replacing the literal at `:27`) and `RenderFileData.media_type`.
- Run `npm run build:shared`.

**Frontend**

- In `MediaRenderer`, a `"file"` branch draws a compact card:
  - a lucide `File` icon, the file name, `formatBytes(file_size)` and `mime_type`
  - a **Download** `<a href="/api/files/serve?path=…&download=1" download>` styled as a button
  - the caption below
- No preview and no `FullscreenFrame`. The untrusted gate still applies: the card shows behind "View anyway" just as media does.
- Colours use only `var(--…)` (`--border`, `--text`, `--text-muted`, `--bg-secondary` or whatever `index.css` actually defines). No new variables.
- Optionally also add a small Download icon button to the existing image/audio/video/PDF headers (same URL plus `download=1`). It is cheap, and useful on iOS where saving media is awkward. Recommended.

**Capability gate: decision is no gate.** Reasons:

1. **The gate cannot be enforced at this point.**
   - A render_file result is a JSON string written into the transcript when the tool is called, inside the agent's MCP server. That server has no `StreamSession`, so there is no `session.supports()` to consult.
   - The same persisted result is later read over REST (`GET /messages`) by every tab that opens the chat, of any bundle age, now and in the future.
   - A gate here would mean rewriting tool-result content per client when the transcript is served. That is new machinery, it applies to every provider's parser, and the payoff is small.
2. **Old clients degrade gracefully; they don't drop anything.**
   - CLAUDE.md's gate rule exists because an unknown `stream.ts` `type`/enum value hits a `switch` default and the **event is lost**.
   - Here, an old bundle's `parseUiToolResult` returns `null`, and `ToolCallBubble` falls back to the generic tool bubble: tool name, args, and the raw JSON result including `file_path`, `file_size` and `mime_type`.
   - The user still sees what the agent shared, and the next reload fixes it.
3. **The wire surface does not change.**
   - `media_type` lives inside a `tool_result` content string, not in `shared/types/stream.ts`, so `wire-surface.snapshot.json` must stay untouched.
   - If `stream.test.ts` fails in PR2, something else changed by mistake.
4. **Rejected alternative:** a separate tool (`share_file`) would have avoided the enum value. It was rejected because it means one more tool for models to choose between, and the old-client result would be the same generic bubble anyway.
5. **Reverse skew is acceptable too.** A new bundle with an old daemon never receives `"file"`. A Download button on a media card would request `download=1`, which the old daemon ignores, so the file is served inline and opens instead of downloading.

Record this reasoning in a comment above `RENDER_FILE_MEDIA_TYPES` so the next person adding a value does not reach for a capability.

### 2. Video in the chat gallery

**Decision: yes, videos join the gallery**, with gestures restricted so the native controls keep working.

- **`LightboxItem`:** add `kind?: "image" | "video"` (absent means image) and `poster?`.
  - `ChatGallery` has no other changes; registration and DOM ordering already work for any element.
- **`MediaRenderer`**
  - Video registers through `useGalleryItem` under the same conditions as images: not gated, not errored.
  - Its expand button opens the gallery at that video instead of `FullscreenFrame`.
  - `display_mode: "fullscreen"` auto-opens the gallery, as images already do.
  - Audio and PDF keep `FullscreenFrame`.
- **`ImageLightbox`** (keep the name; a rename is churn):
  - **Element:** a video slide renders `<video src controls playsInline preload="metadata">`. Neighbour slides get `preload="none"`.
  - **Pausing:** whenever the index changes, pause every mounted `<video>` except the current one, and pause all of them on close.
  - **Gestures:** a pointer-down whose target is the `<video>` element does not start a lightbox gesture, so the native controls (scrubbing, volume, play) handle it. This covers swipe-x, swipe-y-to-close, pinch, pan and double-tap.
  - **Navigation:** on a video slide you leave by swiping on the backdrop, the prev/next buttons, ← → keys, or Esc. No zoom on video.
  - **Labels:** aria-labels and the counter become media-neutral: "Previous item", "Next item", "Close viewer". Update the existing tests that query by those names.
  - **Focus:** hand focus back to the inline video's expand button on close, using the existing `focusTarget` logic.
  - **Seeking:** depends on PR1's Range support. Without it Safari would not play the video at all.
- The **minimum fallback**, if gesture conflicts prove fragile during implementation: videos stay out of the gallery, but `FullscreenFrame` video gets `playsInline` and PR1's seeking. Only cut to this with a recorded reason. The recommended scope is the full one above.

### 3. Descriptions

The new wording goes into `callboard-tools.ts` (the tool definition) **and** `mcp-tool-registry.ts:26` (the UI copy). Keep the two identical.

> Render a file in the chat UI. Images (png, jpg, gif, webp, avif, svg, …), audio (mp3, m4a, wav, ogg/opus, flac, …), video (mp4, m4v, webm, mov, ogv) and PDFs render inline; any other local file is shown as a download card with name, size and type. Local files (absolute path) or http(s) URLs to media; URLs must point at a supported media type. Provide either file_path or url, not both. If the content is from an untrusted or suspicious source, set untrusted=true with a reason.

### PR2 files

- `shared/types/callboard-ui-tools.ts`, then `npm run build:shared`
- `backend/src/utils/media-types.ts` (`DESCRIPTIVE_MIME`)
- `backend/src/services/callboard-tools.ts`: the `file` branch and the description
- `backend/src/services/mcp-tool-registry.ts`: the description
- `backend/src/routes/files.ts`: `download=1`
- `frontend/src/components/uiToolResult.ts`
- `frontend/src/components/MediaRenderer.tsx`
- `frontend/src/components/gallery/ImageLightbox.tsx`, `frontend/src/components/gallery/ChatGallery.tsx` (types only)
- Tests: `ImageLightbox.test.tsx`, `ChatGallery.test.tsx`, a new `MediaRenderer.test.tsx` if none exists, `uiToolResult.test.ts` (or wherever its tests currently live), and `served-content.http.test.ts`

### PR2 tests

```sh
npm run build:shared
npx vitest run shared/types/stream.test.ts backend/src/routes backend/src/services/callboard-tools frontend/src/components/gallery frontend/src/components/MediaRenderer frontend/src/components/uiToolResult
npm run lint:all
```

- **Backend:**
  - render_file on `.zip`, `.html` and `.vtt` returns `media_type:"file"` with a descriptive `mime_type`.
  - render_file on a directory and on a missing path still errors.
  - render_file with a URL to `.zip` errors.
- **`download=1`:**
  - An `.html` file and an `.svg` file are each served as `application/octet-stream` + `attachment`, with `nosniff` and the CSP. This is the key security test.
  - A filename containing `"`, CR/LF and non-ASCII produces a well-formed `Content-Disposition`.
  - Range on a download → 206.
  - `download=1&url=` → 400.
- **`uiToolResult`:**
  - `"file"` parses.
  - An unknown media_type such as `"model3d"` still returns `null`, which pins the graceful-degradation path described above.
- **`MediaRenderer`:**
  - The file card shows name, size, type and a Download href with `download=1`.
  - The untrusted gate hides the card until "View anyway".
- **Gallery:**
  - Image, video and image in DOM order gives a three-item strip.
  - A video slide renders `<video controls playsInline>`.
  - A pointer-down on the `<video>` does not swipe, but on the backdrop it does.
  - Navigating away pauses the video.
  - A gated or errored video is not registered.
  - The video's expand button opens the gallery at its own index.
- **Wire:** `stream.test.ts` passes **without** regenerating the snapshot.
- **Manual (dev server):**
  - Mixed image/video chat: swipe through it on a phone, and scrub a video inside the lightbox without the gallery moving.
  - File card download in Chrome and Safari.
  - An old-bundle check: keep a tab on a pre-PR2 build open and render a `.zip`; it should show the generic tool bubble.

---

## Security considerations

1. **Everything served lives on the app origin.**
   - Every response keeps `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`, including 206, 416, HEAD and downloads. Tests assert this on each.
2. **Inline types are an allowlist of inert renderers.** The guard test in PR1 §1 enforces it.
   - `image/svg+xml` is the only script-capable type, and it is neutralised by the sandbox CSP.
   - HTML, XML, JS and CSS are never inline, and `text/plain` is not in the table either.
3. **Downloads are never typed from content.**
   - `application/octet-stream` + `attachment` + `nosniff` + CSP.
   - Even if a browser ignores `attachment` (some in-app webviews do), the CSP sandbox gives the document an opaque origin with no script.
4. **Download widens what `?path=` can serve: any regular file, not just media.**
   - Accepted for these reasons:
     - The endpoint is behind the same authentication as the rest of the API.
     - The authenticated user already has full filesystem read through their agents.
     - `/git/diff/file/raw` already serves arbitrary repo files.
     - The bytes are never interpreted on the origin.
   - A CSRF read is impossible: a cross-site request cannot read the response, and the cookie is SameSite.
   - See Q1 for the tighter alternative.
5. **Range parsing never forwards raw client input.** The upstream sees only a range we re-serialised from integers.
   - Upstream `Content-Range` is regex-validated before it is relayed.
   - Our own response's `Content-Type` is always extension-forced.
6. **The proxy keeps** the public-address check on every hop, the 30 s connect/headers timeout and the 60 s body idle timeout, disconnect cleanup and a per-response 100 MB cap.
7. **The `Content-Disposition` filename** is sanitised (no CR/LF or quotes in the ASCII form), with `filename*` encoded by `encodeURIComponent`.

## Open questions (with recommendations)

1. **Should `download=1` serve any path, or only paths a render_file result has named?**
   - **Recommend: any regular path** (PR2 §1), for the reasons in Security #4.
   - Tightening it later is easy: render_file can register `realPath` in an in-memory set, persisted to `~/.callboard`. Doing that now adds a store that has to survive restarts for old transcripts to keep working.
2. **Should `"file"` cards work for URLs with an unknown extension?**
   - **Recommend: not in Phase 1.** It needs either an open-ended download proxy (bandwidth, and a policy for content we cannot type) or a raw link to the external origin (referrer and tracking).
   - Keep the error, and revisit if agents ask for it.
3. **Should the video player attach captions (`.vtt`) automatically?**
   - **Recommend: Phase 2.** It would be an optional `captions_path` arg on render_file, mapping to a `<track>` element. PR1 already serves `text/vtt`, so it is just a new optional field and needs no gate.
4. **Is removing the local-file cap safe?**
   - **Recommend: yes.** It is bounded by backpressure and by what the client actually requests.
   - If one is wanted anyway, use a 4 GB sanity limit on **render_file** only (not on serving), so a mistaken `render_file /dev/…`-style call on a huge image does not hang a tab. `isFile()` already excludes devices, so this is low priority.
5. **`res.sendFile` or hand-rolled Range code?**
   - **Recommend `sendFile`/`send`**: it is already a dependency, well tested, and includes HEAD/ETag/`If-Range`.
   - Keep the hand-rolled single-range fallback described in PR1 §2 if `send`'s 404-on-error or Content-Type handling surprises us.
6. **Should multi-range requests get multipart responses?**
   - `send` supports them for local files. For the proxy we drop multi-range and return 200. That is fine: browsers' media stacks send only single ranges.
7. **Should the lightbox be renamed now that it holds video?**
   - **Recommend: no.** Change only the user-visible labels and leave the code names.
