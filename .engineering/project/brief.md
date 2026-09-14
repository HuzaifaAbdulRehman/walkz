# Project brief

Status: building Milestone 7
Owner: Huzaifa Abdul Rehman
Decision date: 2026-09-14

## Project profile

Walkz is a high-risk developer tool with a local CLI and a self-hosted GitHub App. Its
Node.js and TypeScript workspace now includes a Fastify API, BullMQ worker, Next.js
dashboard, PostgreSQL, Redis, Groq, and isolated Docker proof execution. Private source,
credentials, migrations, asynchronous work, user interface, and release artifacts are
all inside the review boundary.

## Problem

AI reviewers can make convincing claims without proving that a pull request caused a
defect. Missing context, invented locations, provider failures, and command failures can
then look safer than they are. Walkz separates model suggestions from merge decisions and
makes incomplete coverage visible.

## User and outcome

A solo developer or small-team maintainer can review a branch locally or from GitHub,
receive a deterministic verdict tied to exact commits and evidence, and approve a fix
that Walkz proves again before reporting it. Milestone 7 turns that working path into a
reproducible, operable single-host beta.

## Evidence

CodeRabbit already covers much of the Milestone 1 CLI workflow, including local Git
scopes, diagnostics, terminal output, and JSON. Milestone 1 is therefore a foundation,
not the product's differentiator. See <https://docs.coderabbit.ai/cli/index>.

GitHub warns that AI review can miss problems, report false positives, and suggest unsafe
fixes. A 2026 field dataset also found more rejected than accepted CodeRabbit comments.
See <https://docs.github.com/en/enterprise-cloud@latest/copilot/responsible-use/agents>
and <https://arxiv.org/abs/2607.03316>.

Node, Git, Groq, GitHub, PostgreSQL, Redis, and Docker documentation support the main
boundaries. The full claim, source, and run records are in `evidence.json`. The current
checkpoint also records a clean-revision image build, bounded operational telemetry,
and a timed restore and rollback drill against exact release images.

## Scope

Milestone 7 packages the verified local and hosted paths for a single-host beta. Phase
7.4 adds a bounded logical backup, isolated restore, durable queue reconciliation, and
exact-revision upgrade and rollback rehearsal.

## Non-goals

Phase 7.4 does not select a hosting vendor, publish images to a registry, expose the
stack to the internet, retain production backups, or add a separate proof-executor
host. It also does not prove a clean-host installation. Those checks remain in later
Milestone 7 phases. Real-user usefulness remains a separate outcome gate.

## Constraints

Use free-first Groq access with no paid fallback and a zero spending cap. Do not select
paid infrastructure or publish the repository without explicit approval. Private code
and BYOK credentials must stay out of images, logs, and telemetry. The release must bind
every application image to one source revision and keep durable data independent from
container replacement.

## Risks and assumptions

The largest operational risks are losing PostgreSQL data, running mismatched application
images, exposing internal services, leaking credentials through rendered configuration,
and giving a container too much host authority. The worker still needs the Docker socket
for proof execution, so the local daemon remains a deliberate high-trust boundary.

The riskiest product assumption is that evidence makes a review more useful than the
same checks plus an existing assistant. Test it on 10 to 20 historical defects once
Milestone 2 can produce base/head proof. The first engineering experiment tests Execa's
shell-free command resolution and descendant cleanup on Windows and Linux.

## Success and stop conditions

Phase 7.4 succeeds when a known review survives a real backup and isolated restore,
missing Redis work is rebuilt from PostgreSQL, and exact application images move
forward and back without losing the migration ledger. Milestone 7 is not complete
until the clean-host beta journey passes.

Revisit the deployment design if a service can build from source at startup, an internal
port reaches the host, a secret appears in verification output, or a release mixes image
revisions. Stop product expansion if the later real-diff comparison does not improve
decision usefulness over CodeRabbit or checks plus an assistant.

## First slice

The completed slice is release recovery. A disposable drill restores one synthetic
review, rebuilds its BullMQ job from PostgreSQL, starts a newer release, and rolls API
and worker back to the exact baseline. It removes the temporary dump and all drill
resources before reporting success.

## Delivery path

1. Build immutable API, web, and worker images from one clean revision.
2. Add and verify the standalone production Compose contract.
3. Expose bounded operational telemetry without review content or credentials.
4. Rehearse backup, restore, upgrade, rollback, restart, and queued-work recovery.
5. Run the complete beta journey from a clean host using exact image digests.

Each phase receives a focused playbook review after the code exists. A phase ends only
when its checks pass and its commits describe observable behavior.

## Lifecycle gates

The next gate is Phase 7.4 backup, restore, upgrade, rollback, and restart recovery.
Huzaifa owns every gate.

- Passed, release: Milestone 1 passed a clean install, 189 tests, the local demo,
  Gitleaks, OSV, and Windows plus Ubuntu CI at `c24c993`.
- Passed, during: proof contracts and planning passed 218 tests in normal and shuffled
  order. The authorization test failed when its gate was deliberately disabled.
- Passed, during: exact base and head workspaces leave the developer's dirty tree
  unchanged, preserve committed bytes, reject unsafe links and paths, and clean up
  after success, failure, or cancellation. The full suite passed 236 tests, and the
  cleanup test failed when cleanup was deliberately disabled.
- Passed, during: exact base and head trees run with the same pinned image and command.
  The runtime has no network or host secrets, uses bounded resources, and removes its
  containers after success, failure, timeout, or cancellation. The full suite passed
  258 tests, and seven opt-in tests passed against Docker Desktop's Linux engine.
- Passed, during: matching plan, command, revision, and SHA records now bind paired
  results to findings. A base pass and head failure creates `VERIFIED` evidence. Equal,
  inverse, cancelled, timed-out, infrastructure, and forged-provenance cases stay
  non-blocking. The full shuffled suite passed 278 tests, including the real Docker
  regression proof.
- Passed, during: the golden proof demo ran one broken and one clean change. It
  caught the broken case, reported no false positives, verified one proof, and
  recorded no provider invocation. The test failed when its measured
  classification was deliberately removed.
- Passed, release: Milestone 2 passed a local Windows clean clone and clean
  Windows and Ubuntu CI for `9162717`.
- Passed, during: the standalone production Compose contract passed 10 focused tests,
  workspace typechecking, 796 full-suite tests, dependency and secret scans, and a live
  disposable deployment from clean revision `6586547`. The web edge returned HTTP 200,
  20 migrations were present, the three application image IDs matched the release
  manifest, and cleanup left no acceptance containers or volumes.
- Passed, during: API and worker telemetry passed 808 full-suite tests, an exact-release
  Compose run, bounded Redis failure and recovery checks, secret and dependency scans,
  and cleanup with no acceptance containers or volumes left.
- Passed, during: a 93,387 ms disposable drill restored one 78,929-byte dump and a
  known review across 21 migrations, rebuilt its missing BullMQ job, started candidate
  revision `8ac1b42`, rolled API and worker back to `8a15d0b`, and left no backup,
  container, network, or volume behind.
- Planned, outcome: after 10 to 20 real diffs exist, compare Walkz
  with CodeRabbit or a composed baseline on precision, recall, latency, and decision
  usefulness.
