# CDN Stall Recovery Design

## Scope

Stage 3 adds conservative recovery for media requests that are visible to page-realm Fetch or
XHR. It is enabled only when `balh_cdn_mode=auto` and reuses exact signed candidate groups from
the playurl payload finally delivered to page code, including transformations made by a later
compatible response wrapper.

The recovery path has four hard boundaries:

1. It never synthesizes a URL, combines fields from different URLs, or crosses a candidate-group
   boundary.
2. It changes only a future Fetch/XHR `GET`; it never aborts, reloads, reopens, or replays an
   in-flight request.
3. Exact signed URLs remain in memory only. Storage, normal logs, diagnostics, and status objects
   contain only structural group identifiers, host-only summaries, and counters.
4. Missing or ambiguous evidence is fail-open. Native media loading that bypasses page Fetch/XHR
   is reported as unsupported instead of being presented as a successful recovery.

`safe`, `original`, and `manual` retain their existing meanings and never perform Stage 3
automatic routing. The experimental static candidate pool remains disabled by default and is not
part of this delivery.

## Reusable module boundary

The implementation is split into three layers so that another userscript can reuse the design
without importing BALH proxy behavior:

```text
final playurl delivery
  -> transparent final-response observer
  -> exact in-memory group registry
  -> pure per-group recovery state
  -> Fetch input mapper / XHR pre-open mapper

standard document + video signals
  -> DOM signal adapter
  -> deterministic stall monitor
  -> advance future-route intent for active exact groups
```

- `cdn_media_request_routing.ts` owns exact groups, reverse lookup, group generations, attempted
  candidates, and future-route overrides. It does not read the DOM or storage.
- `cdn_recovery.ts` owns the deterministic state machine and injected clock/signal interfaces. It
  does not know BALH proxy endpoints.
- `player_stall_monitor.ts` is the browser adapter for standard `document` and
  `HTMLVideoElement` signals. It does not use Bilibili private player APIs.
- `cdn_recovery_browser.ts` owns the BALH-specific singleton, live `auto`-mode guard, monitor
  lifecycle, and transactional Fetch/XHR adapters. The lower layers remain reusable without
  importing BALH proxy or settings behavior.
- `cdn_final_delivery_observer.ts` keeps a transparent observer outside the current Fetch/XHR
  response chain. It republishes the exact groups in the response that page code will receive,
  without applying CDN policy again or replacing the predecessor `Response` / XHR object.

## Exact group registry

### Publication

The shared CDN runtime already sees `CdnCandidateGroup[]` before Stage 2 flattens candidates by
URL/host. A BALH policy adapter first publishes its post-policy result. The outer final-response
observer then republishes after every compatible downstream transformer and before page code can
consume the delivered playurl response. Therefore a short-lived inner publication cannot become
the route source for a request derived from the downstream response. The authoritative delivery
publication follows these rules:

- `safe` / `auto`: publish the post-policy collection, never the pre-policy collection;
- `original`: publish the collected original order;
- `manual`: publish the completed manual delivery result, while Stage 3 remains disabled;
- collection failure: atomically publish an empty registry so stale signed URLs cannot survive.

The observer uses assignment-aware Fetch/XHR slots. If another userscript assigns a wrapper after
BALH, the slot exposes a fresh observer around that wrapper while the wrapper may continue calling
the exact predecessor it captured. This avoids recursion and makes both load orders converge on
the downstream response. Fetch awaits and parses only a clone, then returns the exact predecessor
`Response`; XHR observes `DONE` before page listeners while preserving the public XHR instance and
native response getters. Only official HTTPS Bilibili playurl paths are inspected. Unsupported,
non-configurable, hostile, or unreadable hook descriptors remain fail-open.

Each supported playurl Fetch call / XHR `open()` receives a monotonic delivery order before its
predecessor starts. All active observation layers for that delivery use the same accepted order;
superseded inner observers remain transparent. If a newer playurl finishes first, a late older
response cannot become authoritative: after its inner BALH adapter settles, the outer observer
restores the immutable group snapshot from the newest accepted final delivery before returning the
old response to its caller. A synchronous Vue/hydration delivery receives a new order and likewise
supersedes any older pending transport. Tokens and snapshots are memory-only and never enter status,
logs, or storage.

Final observation never runs selection or host replacement a second time. It only refreshes the
Stage 2 candidate view and the Stage 3 exact registry from the already delivered payload. A changed
final group generation invalidates any transient inner probe/recovery work; repeated byte-identical
publication is idempotent.

An explicit BALH close is stronger than the CDN mode. A fresh closed run installs neither the
monitor nor final-response observers; the runtime also treats a later in-page close as non-auto so
an already installed observer cannot schedule a probe or enable recovery.

The registry copies immutable structural data and exact URL strings; it never retains the mutable
playurl payload. Its canonical generation key includes group `kind`, structural `key`, and ordered
exact candidate URLs. A byte-equivalent repeated delivery does not reset recovery. Any group
assignment or URL-order change increments generation and invalidates old activations and timers.

An active video element replacement also begins a new context. Episode, quality, audio, or video
changes normally replace the signed group generation; an explicit context reset remains available
for the DOM adapter when the element changes before new playurl data arrives.

The browser composition keeps publication intent separate from the live setting. Leaving `auto`
disables the router, invalidates timers and activations, and resets every group to an unseen state
before another request can be routed. Re-entering `auto` may reuse the same in-memory publication,
but it starts without an old override, attempt set, grace token, or cooldown state.

### Exact matching

For each candidate, the reverse index registers:

- the exact upstream string;
- for a protocol-relative candidate only, `${location.protocol}${candidate.url}` as the single
  browser-resolved alias.

If the live page protocol is missing, unreadable, or invalid, the router does not guess a protocol
and registers no resolved alias.

It does not lowercase, reorder query parameters, decode escapes, remove signatures, discard a
port, compare only host/path, or infer a derived segment URL. A lookup must resolve to exactly one
`{groupId, candidateIndex}`. Zero matches, cross-group duplicates, alias collisions, and any other
ambiguity return the original request unchanged.

The fallback view is a stable partition of the delivered candidates: ordinary candidates first,
then MCDN/PCDN-risk candidates, while order within each partition is preserved. If every candidate
is risky, original order is preserved. The current observed candidate counts as attempted.

### Activation and route intent

A group changes from `unseen` to active only when a page Fetch/XHR `GET` uniquely matches one of
its exact candidates. A confirmed stall is broadcast only to active groups in the current context.
Each eligible group independently advances its future-route override to its next untried exact
candidate. The request that supplied the evidence is already in flight and remains untouched.

An immutable activation binds:

```ts
interface RouteActivation {
    contextEpoch: number
    generation: number
    groupId: number
    routeRevision: number
    candidateIndex: number
}
```

Every advance revalidates all five fields. Old generation/revision activations and duplicate
completion signals are no-ops. Exhaustion preserves the last exact candidate and never returns an
empty or fabricated URL.

Request observation is transactional. `prepareExactUrl()` computes an exact decision and opaque
token without changing active/attempted state. `commit()` revalidates the context, generation,
group, route revision, exact match, and target before observing the request; `discard()` leaves
routing state untouched. Fetch commits only after its predecessor accepts the call. XHR commits
only after the single native `open()` returns successfully. This prevents constructor errors,
synchronous predecessor errors, native/WebIDL failures, and reentrant outer-open rollback from
creating a request that never existed or undoing a successful inner request.

The native acceptance boundary is itself reentrant: a Fetch predecessor or XHR WebIDL/open path
can synchronously replace the active video after `prepare()` and before `commit()`. The browser
adapter therefore synchronizes video identity both before preparation and immediately after native
acceptance. If that synchronization advances `contextEpoch`, the old token stays stale and BALH
re-observes only the exact URL that was actually accepted, and only when the current router would
leave that URL unchanged. It never sends a second request or applies a newly computed override to
an already accepted call.

## Playback signals

The DOM adapter samples only standard properties:

```ts
interface PlaybackSignals {
    visible: boolean
    paused: boolean
    seeking: boolean
    ended: boolean
    currentTimeSeconds: number
    durationSeconds: number | null
    bufferedAheadSeconds: number | null
}
```

`bufferedAheadSeconds` is the greatest finite `buffered.end(i) - currentTime` for a range that
contains the current position. No containing range is a known `0`; an exception, non-finite value,
or unreadable `TimeRanges` is `null` and fail-open. Natural completion is excluded when `ended` is
true or a finite duration is within `0.5 s` of `currentTime`.

The adapter prefers exactly one connected, non-ended video that is currently playing. If that is
not available, it accepts exactly one connected media-bearing video. Multiple equally plausible
videos are ambiguous and produce no sample. Video replacement starts a new context.

An enabled but inactive monitor may wake to synchronize video identity, but it does not submit a
playback sample or install the `500 ms` poll until an exact request activates a group. Reentrant
wakes are drained through a bounded synchronous loop so a second-level wake cannot leave a stale
video identity; the timer token still guarantees at most one live poll.

`visibilitychange`, `play`, `pause`, `seeking`, `seeked`, `progress`, `timeupdate`, `waiting`,
`stalled`, and `playing` only wake sampling; no event is stall proof by itself. While at least one
group is active, a bounded `500 ms` sample loop covers browsers that coalesce media events.

## Per-group state machine

Each active exact group owns an independent reducer. One DOM sample may be broadcast to several
active audio/video groups, but their candidates, attempts, cooldowns, and timers never mix.

| State | Event and guard | Transition and action |
|---|---|---|
| `disabled` | groups published, mode is `auto`, adapters available | `unseen` |
| `unseen` | unique exact `GET` begins | `monitoring`; record the observed candidate as attempted |
| `monitoring` | eligible low-buffer sample at or after `retryAt` | `confirming`; start a grace token |
| `confirming` | sample becomes hidden, paused, seeking, ended, near-end, healthy, or unknown | `monitoring`; invalidate the grace token |
| `confirming` | playback advances at least `0.25 s` while buffer stays low | remain `confirming`; restart the full grace interval |
| `confirming` | current grace expires, sample is still eligible/low, and progress stayed below `0.25 s` | advance future route and enter `waiting-retry`; if no candidate remains, enter `exhausted` |
| `waiting-retry` | `now >= retryAt` | low buffer starts a fresh `confirming`; otherwise `monitoring` |
| `waiting-retry` / `exhausted` | buffer is at least `3 s` and non-seeking playback advances continuously for `5 s` | reset attempts to the current candidate and reset backoff; do not shorten an existing cooldown |
| any | context/generation change, active video replacement, leaving `auto`, or explicit disable | invalidate timers/activations and return to `disabled` or `unseen` |

An eligible low-buffer sample is exactly:

```text
visible
&& !paused
&& !seeking
&& !ended
&& !nearEnd
&& bufferedAheadSeconds != null
&& bufferedAheadSeconds <= 0.5
```

Default timing constants are:

| Parameter | Default |
|---|---:|
| low-buffer threshold | `0.5 s` |
| progress that restarts grace | `0.25 s` |
| confirmation grace | `3,000 ms` |
| minimum post-switch cooldown | `15,000 ms` |
| retry backoff | `5,000 ms * 2^(attempt - 1)` |
| retry backoff cap | `60,000 ms` |
| stable buffer threshold | `3 s` |
| stable playback reset window | `5 s` |
| active sampling interval | `500 ms` |

After a switch:

```text
retryAt = switchedAt + max(15_000, min(5_000 * 2^(attempt - 1), 60_000))
```

Hidden, paused, seeking, and unknown samples cancel grace but do not erase failure history.
Backoff and the attempted set reset only after stable recovery or a new media context/generation.

Every timer captures `{contextEpoch, generation, groupId, timerRevision}`. Replacing groups,
resetting context, cancelling grace, or scheduling a newer timer increments the relevant revision.
Duplicate signals cannot create a second timer or consume a route twice.

Injected timer implementations are treated as untrusted adapters: synchronous callbacks,
registration that throws after retaining a callback, early firing, failed cancellation, and stale
duplicate firing all fail open behind the same revision fence. A timer also re-checks the live
`auto` guard before advancing a route.

## Failure evidence

Transport outcomes are diagnostic input, not an independent switch trigger. DOM grace must still
confirm a stall.

| Outcome | Classification | Routing effect |
|---|---|---|
| HTTP other than `200` / `206` | `network-failure` | eligible supporting evidence only |
| XHR timeout | `timeout` | eligible supporting evidence only |
| Fetch `TypeError` / XHR error where CORS and network cannot be separated | `transport-unprobeable` | no negative CDN claim |
| caller abort | `caller-abort` | no failure claim |
| BALH/extension cancellation | `extension-cancel` | no failure claim |
| wrapper/adapter exception | `adapter-error` | fail-open to predecessor |

Transport evidence never bypasses visibility, pause, seek, buffer, progress, cooldown, or
generation guards.

## Fetch contract

Routing happens after existing request preprocessing and immediately before the captured
predecessor call. Only an effective `GET` is eligible.

- string input: replace only the string;
- `URL` input: create the exact target `URL`;
- `Request` input: use `new Request(exactTarget, input)` and pass the caller's original `init`
  unchanged.

Method, body, headers including `Range`, credentials, cache, redirect mode, referrer, integrity,
keepalive, and abort signal retain normal Fetch override semantics. A consumed/locked body,
constructor exception, router exception, unsupported input, or ambiguous match calls the
predecessor once with the original `input` and `init`. Media responses are returned as the exact
predecessor `Response` object.

Preparation itself does not activate a group. After a routed input is constructed, BALH calls the
captured predecessor once; a synchronous predecessor throw discards the prepared token. Once the
predecessor accepts the call, BALH commits observation and then awaits the original result. A
rejected Fetch still represents an attempted request, while construction failure does not.

## XHR contract

The existing `injectXhr` receives one optional synchronous `transformOpenUrl` seam. It runs before
the single captured native `open()` call and only for primitive string method/URL pairs whose
method is `GET` case-insensitively. The seam accepts the legacy primitive string result or a
transactional `{ url, commit?, rollback? }` result. BALH uses the transactional form: native
success calls `commit` exactly once, while native/WebIDL failure calls `rollback` exactly once.
Hook exceptions never change the already-determined native outcome.

Only `args[1]` may change. `method`, `async`, `user`, `password`, later request headers/`Range`,
`withCredentials`, timeout, response type, `send(body)`, `abort()`, subclass private fields,
WeakMap identity, and native brand stay on the same native XHR instance. The open transaction
stores the routed arguments only after native `open()` succeeds; a throw discards the tentative
mapping and preserves the previous committed request state. The implementation never opens the
original URL and then reopens the target.

## Test and acceptance matrix

### Deterministic tests

- state boundaries at `grace - 1`, grace, cooldown, every backoff step, cap, and stable reset;
- low buffer with real progress; hidden, paused, seeking, ended, near-end, unknown buffer, and
  low -> healthy -> low transitions;
- duplicate signals/timers, context and generation replacement, old activations, and exhaustion;
- inactive video-identity synchronization, nested reentrant wakes, and replacement during the
  native predecessor window followed by accepted-URL re-observation in the new context;
- synchronous/early/throw-after-register timers, failed cancellation, and `auto` disable/re-enable;
- ordinary `N1 -> N2 -> M1`, all-risk, single-candidate, unobserved-group isolation, and
  cross-group duplicate ambiguity;
- absolute/protocol-relative exact matches and one-byte differences in path/query/escaping;
- Fetch string/URL/Request, effective GET/non-GET, locked body, receiver/call count, headers,
  `Range`, credentials, body, signal, and fail-open identity;
- XHR native `open()` once, successful/failed/reentrant open, headers, `Range`, credentials, body,
  abort/reuse generation, transactional commit/discard, subclass/private-field/WeakMap identity,
  and native response identity;
- exact URL absence from storage, status, logs, and thrown diagnostics.

### Browser gates

1. A controlled real-Chromium E2E covers Fetch and XHR with actual predecessor requests, standard
   DOM signal sampling, held current requests, grace boundaries, future exact rerouting,
   recovery, and cooldown. It also runs with the pinned latest CDN Switcher in both load orders,
   starting from source-host candidates and proving that only the post-Switcher exact groups can
   activate recovery.
2. The live Bilibili smoke continues to prove actual playback plus Stage 2 probe/cache behavior.
   A Stage 3 capability mode records browser `resourceType` and page-hook counters without logging
   signed URLs.

Stage 3 capability has four explicit terminal results:

- `PASS`: an interceptable future request uses the exact same-group alternate, current request is
  not aborted/reloaded, playback resumes, and cooldown holds;
- `FAIL`: transport is interceptable but a required invariant fails;
- `UNSUPPORTED`: native media loading bypasses page Fetch/XHR;
- `INCONCLUSIVE`: no unique request/group, no alternate, or bounded fault injection cannot produce
  a valid low-buffer window.

`UNSUPPORTED` and `INCONCLUSIVE` are non-success results for the Stage 3-specific capability gate
and must never fall through to a generic `PASS`. They do not replace UK-local manual acceptance.

## Porting checklist

When reusing this design in another userscript or player integration:

1. identify the final response boundary, compose outside supported downstream transformers, and
   republish the exact groups before page code consumes the response;
2. prove that signed URLs remain memory-only and that diagnostics are host/structure-only;
3. add one pre-predecessor Fetch mapper and one pre-native-open XHR mapper for media routing; keep
   the separate final-response observer URL-transparent and identity-preserving;
4. define the standard playback signal adapter and ambiguity rules for that player;
5. keep stall confirmation independent from transport error heuristics;
6. freeze timing constants and token/generation semantics before implementation;
7. test current-request non-interference and future-request identity preservation;
8. report native-loader bypass as unsupported and retain a separate manual acceptance gate.
