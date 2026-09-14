We're building a social media chat platform, see: social_chat_platform_plan.md

# Working on this project

Use GitHub CI, issues, pull requests, milestones and Projects to manage tasks.
No force pushing, pull request history is important, however once a pull request is complete we should squash merge.
Keep pull request and git commit messages concise.

We use PostgreSQL for the database, supporting read replicas and full-text search via tsvector.

Frontend should use TypeScript and be seperate from the backend.
The backend must be an OAuth2 provider allowing 3rd party application developers and all API access should occur using OAuth2 tokens for explicit application and scope control.

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

1. **Plan First**: Write the plan to a GitHub issue with checkable items; associate it with its milestone and the Larynx delivery project.
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Maintain the issue checklist, native dependencies and project status/ownership as you go.
4. **Explain Changes**: High-level summary against each commit
5. **Document Results**: Add review section to the pull request
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

### GitHub Projects and multi-agent coordination

Use **Larynx delivery**, an organisation-level GitHub Project linked to this repository, alongside milestones. Its project URL and live setup status are tracked in [#31](https://github.com/av-evolv/social-chat-platform/issues/31). Milestones describe delivery goals; issues are the work items; pull requests hold detailed plans, implementation and verification; the project provides shared status, ownership and timeline views. Do not create parallel draft tasks for existing issues.

- Add each roadmap issue to the project and its milestone. Keep its linked pull request on the issue rather than scheduling a second project item for the same work.
- Use **Coordination** (table) for ownership and dependencies, **Agent board** for status, and **Timeline** (roadmap) for Start date / Target date grouped by milestone. Show native blocked indicators; inspect issue relationships for the actual prerequisite graph. This is a planning timeline, not an automatic critical-path scheduler.
- Maintain **Status**: Backlog (unscoped/deferred), Ready (scoped and no unresolved implementation blockers), In progress (claimed and actively worked), Blocked (an active issue cannot advance), In review (PR ready, including CI/review), Done (required verification passed and PR merged/issue completed). An unstarted issue with prerequisites stays Backlog; GitHub's native blocked indicator explains why. Closing a prerequisite does not automatically make its dependents scoped or Ready.
- Maintain **Agent** with a unique agent/task identifier; GitHub assignee records the accountable human, not agent identity. Shared GitHub accounts must not use assignee alone as a claim. Only the owning agent/coordinator changes another agent's active status or dates.
- Record real prerequisite relationships with GitHub's native **blocked by / blocking** links, not only checklist text or a free-text custom field. Keep the graph acyclic and avoid redundant/transitive links. Milestone order and a shared technology do not themselves imply a dependency. Split independently deliverable contract/prototype work into subissues instead of blocking every possible parallel activity. Distinguish implementation dependencies from public-release gates; for example #30 gates public auth/deep-link exposure and #20, while isolated OAuth implementation can progress.
- **Claim before coding:** read the issue, native blockers, project status, existing claim comments and linked/open PRs. Have the coordinator allocate one Ready issue per agent. Post a claim with a unique task ID, branch/worktree, intended scope and PR link when available; reread claims after posting. The earliest unreleased claim (GitHub comment creation order/ID) wins. Only the winner sets Agent / In progress and starts work. Claims are an advisory protocol, not an atomic lock; use one coordinator to serialize assignments when launching agents together. Never steal an apparently stale claim or silently overwrite another agent's ownership.
- Use a separate `codex/` branch and worktree per independently owned issue. A coordinator may delegate bounded subagents inside its own issue without creating competing claims. Coordinate overlapping files, schema changes and the shared lockfile; recheck ownership before edits, pushes and merge. Save the detailed issue and verification plan in the draft PR before implementation.
- Set **Start date** when work actually starts and **Target date** only after scoping against available capacity. Targets are revisable forecasts, not promises. Leave unestimated backlog dates and milestone due dates blank; do not invent dates just to fill the Gantt-style chart. When blocked, record the blocking issue or external condition and next action on the issue, then update the forecast when justified. Do not assume moving a roadmap bar reschedules downstream work.
- Keep project fields current at claim, blocker, review and completion transitions. On pause, explicitly release or hand off the claim and record the next action; the next agent verifies the handoff before starting. After required checks pass and a PR is squash-merged, close the issue, mark Done, release the claim and reassess dependents. Preserve the PR's incremental commits; never force-push.

Use `gh project`/GraphQL for project operations and the native issue-dependency API when the installed CLI lacks dependency flags. Project access requires the `project` OAuth scope (repository scope alone is insufficient); do not bypass an access denial or put credentials in repository files. Project workflows must be explicitly configured and verified before agents rely on automatic status updates. Until then, update status and project membership explicitly.

---

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.

