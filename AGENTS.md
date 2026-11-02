## Code Development Standards

When planning or implementing code changes:

1. **Code quality:** Provide the cleanest, most concise implementation that satisfies the requirements. Avoid unnecessary complexity, abstractions, or dependencies.

2. **Consistency:** Follow existing coding conventions, architecture, and implementation patterns wherever appropriate.

3. **Preserve existing code:** Do not remove existing comments. Do not modify, refactor, reformat, or rewrite code unless necessary to implement the requested changes.

4. **Cross-repository analysis:** When changes involve shared database tables, authentication, permissions, API contracts, or other dependencies between the Admin and SPA Proxy applications, analyze both repositories to ensure compatibility.

5. **Regression prevention:** Perform a thorough analysis of affected code paths, dependencies, and existing functionality to identify potential regressions before implementation. Preserve existing behavior unless explicitly instructed otherwise.
   Specifically, before modifying production code:
    1. Identify affected code paths and previously working behaviors, including recovery, cancellation, timeouts, concurrency, cleanup, and resource limits where applicable.
    2. Record what evidence establishes each behavior. Mark assumptions and unknowns explicitly.
    3. Add or identify compatibility tests and run them against the unchanged baseline.
    4. Choose the smallest change that fixes the demonstrated defect.
    Before opening or updating a PR:
    5. Run those same compatibility tests against the change.
    6. Review the diff specifically for changed contracts and removed safeguards.
    7. Report baseline-versus-updated results, unresolved assumptions, and remaining risks. Passing builds or tests alone do not establish regression safety.

7. **Validation:** Run all applicable builds, tests, and syntax checks. Report failures, untested functionality, and any remaining regression risks. Do not claim that successful tests guarantee the absence of regressions.

8. **Change scope:** Clearly identify which repositories and files require modifications. Keep changes minimal and focused. Prepare separate pull requests for each affected repository.

9. **Review:** Provide a concise summary of the implementation, modified files, test results, and any compatibility considerations or required database changes.
