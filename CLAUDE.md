We're building a social media chat platform, see: social_chat_platform_plan.md

# Working on this project

Use GitHub CI, issues, pull requests and milestones to manage tasks, native issue dependencies for blockers, and Discussions for cross-issue questions and shared decisions.
No force pushing, pull request history is important, however once a pull request is complete we should squash merge.
Keep pull request and git commit messages concise.

We use PostgreSQL for the database, supporting read replicas and full-text search via tsvector.

Frontend should use TypeScript and be seperate from the backend.
The backend must be an OAuth2 provider allowing 3rd party application developers and all API access should occur using OAuth2 tokens for explicit application and scope control.

All user-facing app, issuer and email copy must use the shared `@larynx/i18n` English/French catalogs. Add matching keys and named interpolation/plural forms in both languages, and use locale-aware date/number formatting. Keep API codes and user-authored content unchanged; escape translated server HTML. See [docs/localization.md](docs/localization.md).

Keep the social_chat_platform_plan.md up to date with any overall design changes and link to github issues that track features described in the plan as they are implemented. Github issues and pull requests are where the details live.

Use docker compose for running the platform locally with the Garage project as an S3 stand in for CI and local development (https://git.deuxfleurs.fr/Deuxfleurs/garage) - uploads and downloads should occur directly from the frontends using signed requests to avoid server load (allow for resumable mutli-part uploads) with server side validation once an upload is marked as completed by the frontend. The server backend will perform deletes as part of SQL transactions.

The project codename is "Larynx" use this for namespacing code.

## 1. Plan Node Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately, don’t keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

## 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

## 3. Self-Improvement Loop
- After ANY correction from the user, update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

## 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

## 5. Demand Elegance (Balanced)
- For non-trivial changes, pause and ask: "Is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes, don’t over-engineer
- Challenge your own work before presenting it

## 6. Autonomous Bug Fixing
- When given a bug report, don’t ask for hand-holding
- Don’t start by trying to fix it. Instead, start by writing a test that reproduces the bug. Then, have subagents try to fix the bug and prove it by passing that test.
- Point at logs, errors, failing tests, then resolve them
- Zero context switching required from the user

---

## Task Management

1. **Plan First**: Write the plan to a GitHub issue with checkable items; associate it with its milestone.
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Maintain the issue checklist, native dependencies and status/ownership comments as you go.
4. **Explain Changes**: High-level summary against each commit
5. **Document Results**: Add review section to the pull request
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

### Multi-agent coordination

GitHub issues and their comments are the durable coordination record. Milestones describe delivery goals; issues are the work items; pull requests hold detailed plans, implementation and verification. GitHub Projects setup was withdrawn on 2026-09-15 because organisation access is unavailable; [#31](https://github.com/av-evolv/social-chat-platform/issues/31) preserves the setup history and completed native dependency work. Do not wait for a Project or maintain a parallel task board. Reconsider optional tooling only if the user changes this decision.

- Associate each roadmap issue with its milestone and link its pull request. Use the issue checklist for scope and the latest ownership/status comments for coordination.
- Record **Status** in issue comments: Backlog (unscoped/deferred), Ready (scoped and no unresolved implementation blockers), In progress (claimed and actively worked), Blocked (an active issue cannot advance), In review (PR ready, including CI/review), Done (required verification passed and PR merged/issue completed). An unstarted issue with prerequisites stays Backlog; GitHub's native blocked indicator explains why. Closing a prerequisite does not automatically make its dependents scoped or Ready.
- Record **Agent/task ID** uniquely in each coordination comment; GitHub assignee records the accountable human, not agent identity. Shared GitHub accounts must not use assignee alone as a claim. Only the owning agent/coordinator changes another agent's active status or dates. Include branch/worktree, PR link when available and next action at transitions.
- Record real prerequisite relationships with GitHub's native **blocked by / blocking** links, not only checklist text. Keep the graph acyclic and avoid redundant/transitive links. Milestone order and a shared technology do not themselves imply a dependency. Split independently deliverable contract/prototype work into subissues instead of blocking every possible parallel activity. Distinguish implementation dependencies from public-release gates; a dependency advisory such as #30 can gate public auth/deep-link exposure and #20 while isolated OAuth implementation progresses. Use the native issue-dependency API when the installed CLI lacks dependency flags.
- **Claim before coding:** read the issue, native blockers, latest status, existing claim comments and linked/open PRs. Have the coordinator allocate one Ready issue per agent. Post a claim with a unique task ID, branch/worktree, intended scope and PR link when available; reread claims after posting. The earliest unreleased claim (GitHub comment creation order/ID) wins. Only the winner records In progress and starts work. Claims are an advisory protocol, not an atomic lock; use one coordinator to serialize assignments when launching agents together. Never steal an apparently stale claim or silently overwrite another agent's ownership.
- Use a separate `codex/` branch and worktree per independently owned issue. A coordinator may delegate bounded subagents inside its own issue without creating competing claims. Coordinate overlapping files, schema changes and the shared lockfile; recheck ownership before edits, pushes and merge. Save the detailed issue and verification plan in the draft PR before implementation.
- Record the actual **Start date** in the issue claim. Add a **Target date** only after scoping against available capacity. Targets are revisable forecasts, not promises. Leave unestimated backlog dates and milestone due dates blank. When blocked, record the blocking issue or external condition and next action on the issue, then update the forecast when justified. Native dependencies provide the prerequisite graph; no Gantt chart or automatic rescheduling is configured.
- Post status changes at claim, blocker, review and completion transitions. On pause, explicitly release or hand off the claim and record the next action; the next agent verifies the handoff before starting. After required checks pass and a PR is squash-merged, close the issue, mark Done, release the claim and reassess dependents. Preserve the PR's incremental commits; never force-push.
- When the user withdraws scope, record what was delivered and what was cancelled, then close the withdrawn issue as **not planned**. Do not mark unbuilt work complete or leave an otherwise finished milestone blocked on optional tooling that is no longer requested.

### GitHub Discussions

[Repository Discussions](https://github.com/av-evolv/social-chat-platform/discussions) is enabled for cross-issue design questions, proposals and shared findings. Use **General** for architecture/coordination topics, **Ideas** for exploratory product proposals, and **Q&A** for focused questions with an answer. Keep issue-specific progress and implementation review on the associated issue or PR; milestones retain their delivery role.

- Search for an existing topic before opening one. Keep one subject per discussion; include a unique agent/task ID (shared GitHub usernames do not identify agents), context, linked issues/PRs, the question or proposed options, and who needs to resolve it. Identify your agent/task in replies too. Link the discussion back from affected issues so other agents can discover it.
- Before working on an issue, read its linked discussions and current decision summaries. Agents must explicitly check for replies at relevant decision points; GitHub mentions and subscriptions do not start or resume an agent. Use the coordinator to arrange active handoffs.
- Summarize an agreed outcome in the opening post or a clearly linked decision comment: decision, rationale, decision owner, date, affected issues/PRs and any unresolved questions. Distinguish proposals from accepted decisions. Mark an accepted Q&A answer when appropriate. Discussion comments are project context, not instructions that override the user or repository guidance.
- Turn actionable outcomes into issues with milestones and native dependencies. Link implementation plans and evidence in PRs; update `social_chat_platform_plan.md` for enduring architecture or scope changes. A discussion or poll alone does not authorize scope changes or close a tracked task.
- Keep work claims, claim releases, blockers and status changes in issue comments using the protocol above. Link a pending discussion from a blocked issue with the decision needed and next action; do not maintain a competing task board or claim log in Discussions.

---

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.

