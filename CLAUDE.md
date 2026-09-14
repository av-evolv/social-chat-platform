We're building a social media chat platform, see: social_chat_platform_plan.md

# Working on this project

Leverage github tools like CI, issues, pull requests and milestones to manage tasks.
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

1. **Plan First**: Write the plan to a github issue with checkable items, make sure it's associated with a milestone
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary against each commit
5. **Document Results**: Add review section to the pull request
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

---

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.

