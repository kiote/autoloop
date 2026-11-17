# Fork hotfix inventory

This fork preserves local Autoloop reliability fixes as source changes and
regression tests rather than edits to globally installed JavaScript.

Upstream: <https://github.com/mikeyobrien/autoloop>

## Pi RPC: wait for session-level settlement

A provider stream interruption can end a low-level run with
`agent_end.willRetry: true`. Pi then retries automatically. Autoloop previously
resolved the iteration at that intermediate event and terminated Pi before its
retry could finish.

The RPC client now waits for `agent_settled`, retains the final low-level result,
clears errors superseded by recovery, and preserves real failures, aborts,
timeouts and child crashes. Prompts handled without starting a run return
immediately. Abandoned completion waiters are removed.

Tested with the Pi 1.5.0 lifecycle. Older Pi versions that do not emit
`agent_settled` are not supported by this change; they will reach the configured
timeout rather than falsely reporting completion.

## Resume: configuration overrides

`resume` now accepts repeatable `--set key=value` arguments through the existing
harness configuration-override mechanism:

```sh
autoloop resume RUN_ID -b pi --add-iterations 50 \
  --set backend.timeout_ms=7200000 \
  --set event_loop.max_iteration_runtime=2h
```

This replaces a custom API launcher used to extend verification time. The
two-hour value is an operator choice, not a new default. Overrides are scoped to
the resumed process and must be repeated on subsequent resumes. The
`--add-iterations` argument continues to own the iteration budget.

## ACP: closing-pipe and cancellation safety

Full-suite verification exposed successful ACP runs exiting with an unhandled
`EPIPE`: cancellation during shutdown could write to a child pipe while the
child exited. The transport now handles Node's stream error event while still
rejecting failed writes; later writes retain the original failure instead of
silently succeeding on a closed pipe. Asynchronous cancellation failures during
shutdown and timeout are handled without suppressing actual prompt failures.

## Completeness and publication boundary

The installed Autoloop 0.12.0 root package and all seven installed sibling
packages were compared file-by-file against their published npm tarballs.
The only modified installed file was
`@mobrienv/autoloop-backends/dist/pi-rpc-client.js`. Its behavior has been ported
into the TypeScript source here. The timeout workaround is represented by the
resume CLI support above; the ACP fix was discovered while verifying the fork.

No private project files, transcripts, credentials, worker logs or captured
sessions belong in this repository. No dependency changes or product changes
from the projects operated by Autoloop are part of these patches. Creating or
pushing this fork does not install it or switch any running worker.

## Validation and use

```sh
npm ci
npm run build
npm run check
```

The verified gate passed: 229 test files, 2,708 passing tests and four existing
skips. Added executable source lines and branch locations in the four changed
source files were all covered (72 statements and 33 branch locations). This is
diff coverage, not a claim of 100% coverage for the entire repository.

The gate includes lint, type checking and the repository's full coverage suite.
Tests include a real subprocess CLI/RPC regression with a simulated terminated
response and successful same-prompt recovery. The existing external-service
integration skips are unchanged.

After building, use this checkout without replacing a global installation:

```sh
node /path/to/autoloop-fork/bin/autoloop --help
```

These are GitHub source changes, not an npm release under the upstream
`@mobrienv` namespace.
