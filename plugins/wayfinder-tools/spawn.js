// Spawn-from-wfdash (wfdash#4): the host-only write path.
//
// The server's own doctrine is "zero write endpoints" — that stays true for the
// deployed container, which never constructs a spawner. This module exists only
// when an operator starts a host instance with WFDASH_SPAWN=1, and everything
// it can do is: start one `claude` process in a repo folder with a payload the
// reader already had. The GitHub side stays read-only; the spawned agent posts
// its own comment with `gh` under its own permissions.
//
// One-shot by contract: the agent works the ticket, posts its result as an
// issue comment, and stops. The issue thread is the whole memory — a follow-up
// is a new comment plus a new spawn. No session is ever resumed.

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFile = promisify(execFileCb);

/** Session names the dashboard owns. The prefix is the filter for /api/agents. */
export const NAME_PREFIX = 'wf:';

/**
 * Repo → working folder. One rule plus one alias (decided on wfdash#4): every
 * repo lives at /media/storage1/projects/<name>, except hassio-config, whose
 * checkout is the Home Assistant config tree itself.
 */
const FOLDER_ALIAS = { 'hassio-config': '/homeassistant' };
const PROJECTS_ROOT = '/media/storage1/projects';

export function resolveFolder(repoName) {
  return FOLDER_ALIAS[repoName] ?? join(PROJECTS_ROOT, repoName);
}

/**
 * The bootstrap payload: assembled fresh per spawn, nothing accumulates.
 * Everything in it is already on the graph the reader returned — the map, the
 * ticket, the blockers' threads (where wayfinder answers live), and the
 * operator's comment when one was typed.
 */
export function composePayload({ graph, node, comment }) {
  const lines = [];
  const repo = graph.repo;
  const blockers = (graph.edges ?? [])
    .filter((e) => e.blocked === node.number)
    .map((e) => graph.nodes.find((n) => n.number === e.blocker))
    .filter(Boolean);

  lines.push(`# One-shot agent brief: ${repo}#${node.number}`);
  lines.push('');
  lines.push('## Your contract');
  lines.push('');
  lines.push('You are a one-shot agent started from the wfdash dashboard.');
  lines.push(`Work this ticket in the current repo checkout. Obey the repo's own CLAUDE.md.`);
  lines.push(`When you are done, post your result as a comment: \`gh issue comment ${node.url} --body-file <file>\`.`);
  lines.push('State in that comment what you committed, or what you left dirty and why.');
  lines.push('Do not close the issue unless its own done-conditions are met.');
  lines.push('Then stop. Do not wait for a reply — the issue thread is the conversation, and a follow-up arrives as a fresh session.');
  lines.push('');
  if (comment?.trim()) {
    lines.push('## Operator instruction for this run');
    lines.push('');
    lines.push(comment.trim());
    lines.push('');
  }
  lines.push(`## The map: ${graph.map?.title ?? ''} (${repo}#${graph.map?.number ?? '?'})`);
  lines.push('');
  if (graph.map?.destination) {
    lines.push(graph.map.destination.trim());
    lines.push('');
  }
  lines.push('Tickets on this map:');
  for (const n of graph.nodes) {
    lines.push(`- #${n.number} [${n.status}] ${n.title}${n.number === node.number ? '  ← yours' : ''}`);
  }
  lines.push('');
  lines.push(`## Your ticket: #${node.number} ${node.title}`);
  lines.push('');
  lines.push(node.body?.trim() || '(no body recorded)');
  lines.push('');
  for (const b of blockers) {
    lines.push(`## Blocker #${b.number} ${b.title} [${b.status}]`);
    lines.push('');
    for (const c of b.comments ?? []) {
      lines.push(`@${c.author ?? 'unknown'} (${c.createdAt ?? ''}):`);
      lines.push(c.body ?? '');
      lines.push('');
    }
    if (!(b.comments ?? []).length) lines.push('(no thread)', '');
  }
  lines.push(`## The thread so far on #${node.number}`);
  lines.push('');
  for (const c of node.comments ?? []) {
    lines.push(`@${c.author ?? 'unknown'} (${c.createdAt ?? ''}):`);
    lines.push(c.body ?? '');
    lines.push('');
  }
  if (!(node.comments ?? []).length) lines.push('(empty)', '');
  return lines.join('\n');
}

/**
 * The spawner. `claudeBin` is injectable so the process-boundary test can stub
 * the CLI with a script and assert argv/cwd without spending a token.
 */
export function createSpawner({ claudeBin = 'claude' } = {}) {
  return {
    /** `claude agents --json --all`, narrowed to the sessions this feature started. */
    async listAgents() {
      const { stdout } = await execFile(claudeBin, ['agents', '--json', '--all'], { timeout: 10_000 });
      const all = JSON.parse(stdout || '[]');
      return all
        .filter((a) => typeof a.name === 'string' && a.name.startsWith(NAME_PREFIX))
        .map((a) => ({
          id: a.id ?? null,
          name: a.name,
          state: a.state ?? a.status ?? 'unknown',
          cwd: a.cwd ?? null,
          startedAt: a.startedAt ?? null,
        }));
    },

    /**
     * Start one background session for one ticket. Returns { id, name, folder,
     * payloadPath }. Refuses when the repo has no local folder — that is an
     * operator problem to fix, not something to guess around.
     */
    async spawn({ graph, node, comment }) {
      const repoName = String(graph.repo ?? '').split('/')[1] ?? '';
      const folder = resolveFolder(repoName);
      if (!repoName || !existsSync(folder)) {
        const e = new Error(`no local checkout for ${graph.repo} at ${folder}`);
        e.kind = 'no-folder';
        throw e;
      }
      const dir = await mkdtemp(join(tmpdir(), 'wfdash-spawn-'));
      const payloadPath = join(dir, `${repoName}-${node.number}.md`);
      await writeFile(payloadPath, composePayload({ graph, node, comment }), 'utf8');

      const name = `${NAME_PREFIX}${graph.repo}#${node.number}`;
      const prompt = `Read ${payloadPath} and do what it says. It is your complete brief.`;
      // Unattended one-shot. Decided and approved by the operator on wfdash#4
      // (decisions comment): a permission prompt nobody will ever see is a
      // hang, not a safeguard.
      const args = ['--bg', prompt, '-n', name, '--dangerously-skip-permissions'];
      const { stdout } = await execFile(claudeBin, args, { cwd: folder, timeout: 30_000 });
      const id = /backgrounded[^a-z0-9]*([a-z0-9]{8})/i.exec(stdout)?.[1] ?? null;
      return { id, name, folder, payloadPath };
    },
  };
}
