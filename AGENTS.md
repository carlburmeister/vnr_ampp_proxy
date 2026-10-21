## Code Development Standards

When planning or implementing code changes:

1. **Code quality:** Provide the cleanest, most concise implementation that satisfies the requirements. Avoid unnecessary complexity, abstractions, or dependencies.

2. **Consistency:** Follow existing coding conventions, architecture, and implementation patterns wherever appropriate.

3. **Preserve existing code:** Do not remove existing comments. Do not modify, refactor, reformat, or rewrite code unless necessary to implement the requested changes.

4. **Cross-repository analysis:** When changes involve shared database tables, authentication, permissions, API contracts, or other dependencies between the Admin and SPA Proxy applications, analyze both repositories to ensure compatibility.

5. **Regression prevention:** Perform a thorough analysis of affected code paths, dependencies, and existing functionality to identify potential regressions before implementation. Preserve existing behavior unless explicitly instructed otherwise.

6. **Validation:** Run all applicable builds, tests, and syntax checks. Report failures, untested functionality, and any remaining regression risks. Do not claim that successful tests guarantee the absence of regressions.

7. **Change scope:** Clearly identify which repositories and files require modifications. Keep changes minimal and focused. Prepare separate pull requests for each affected repository.

8. **Review:** Provide a concise summary of the implementation, modified files, test results, and any compatibility considerations or required database changes.