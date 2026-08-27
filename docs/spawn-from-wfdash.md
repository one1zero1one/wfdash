# Spawn-from-wfdash

Start a one-shot Claude Code agent from a ticket in the dashboard. The agent
works the ticket in the repo's local checkout and posts its result as an issue
comment. The issue thread is the whole conversation.

Design record and decisions: [wfdash#4](https://github.com/one1zero1one/wfdash/issues/4).
The loop follows chartr's spawn-with-context design (see
[rengwu/chartr](https://github.com/rengwu/chartr)); the code here is original.

## What it needs

- The `claude` CLI on the PATH of the server process, logged in.
- `gh` logged in as you. The spawned agent posts comments with it.
- A local checkout for each repo you spawn into, at
  `/media/storage1/projects/<repo-name>`. One alias exists: `hassio-config`
  maps to `/homeassistant`. Edit both in `plugins/wayfinder-tools/spawn.js`
  for your machine.

## Run a spawn instance

```sh
cd plugins/wayfinder-tools
WFDASH_SPAWN=1 WFDASH_PORT=7812 node server.js
```

- `WFDASH_SPAWN=1` turns the feature on. Without it, the two routes below do
  not exist and the page stays the read-only dashboard.
- `WFDASH_BIND=<lan-ip>` widens the listen address past loopback.

CAUTION: A spawn instance executes commands for everyone who can reach its
port, and it has no auth. Keep it on loopback, or bind it to a network where
that is acceptable to you. Never expose the raw port on a public route.

The deployed container does not set `WFDASH_SPAWN` and runs no agents itself.
Instead it proxies the spawn routes to the host service named by
`WFDASH_SPAWN_URL` (on this deployment: `http://host.docker.internal:7812`).
The public page sits behind oauth2-proxy with a Google login and an email
allowlist. Every allowed account can reach the spawn routes and can start
agents. Add an address to that allowlist only for a person you trust with
command execution on the host.

## Operate

1. Open a map, then select a ticket.
2. Find the Agent row under the title: a state chip, an instruction box, and
   the start-agent button.
3. Type an instruction, or leave the box empty. The agent gets the full brief
   either way.
4. Press start agent. The chip shows `working` within 15 seconds.
5. Wait. The agent posts its result as a comment on the issue. The panel shows
   a new-comment marker on its next poll.
6. For a follow-up, comment on the issue or use the box, then press start
   agent again. The new agent reads the whole thread.

## The agent's contract

The brief is one file, assembled fresh per spawn: the contract, your
instruction, the map body, the ticket list with statuses, the ticket body, the
blockers' threads, and the ticket's own thread. The contract tells the agent:
work in this checkout, obey the repo's CLAUDE.md, post the result with
`gh issue comment`, state what was committed or left dirty, do not close the
issue unless its done-conditions are met, then stop.

Sessions are named `wf:<owner>/<repo>#<ticket>`. State lives in three places,
none of them the server: the issue thread (the conversation), the repo tree
(the work), and the Claude Code harness (the process). The server can restart
at any time and no agent notices.

## If an agent hangs

There is no timeout and no auto-restart. The chip shows what
`claude agents --json` reports: `working`, `blocked`, or `done`.

1. `claude logs <id>` shows what the agent is doing or asking.
2. `claude attach <id>` puts you in the session to answer or unstick it.
3. `claude stop <id>` ends it. Press start agent for a fresh one; the thread
   and the repo tree still hold everything that happened.

Finished sessions stay listed as `done` until stopped. Reap them with
`claude stop <id>`.

## API

- `GET /api/health` — adds `spawn: true|false`.
- `GET /api/agents` — the `wf:`-named sessions, from `claude agents --json --all`.
- `POST /api/spawn` — body `{repo, map, ticket, comment?}`. Refuses a repo
  with no local checkout.

Both routes return 404 when `WFDASH_SPAWN` is unset.
