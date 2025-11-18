
I want the env setup to be as simple in singe setup in gateway. like inputing vps/s creds etc.

===

I want more e2e and integration test cases to met readme.md requirements.

rules;

1. No OOP, only HOFs
2. Use bun.sh and e2e type safe TypeScript
3. No unknown or any type
4. tests/[e2e|integration|unit]/[domain].test.ts files & dirs
5. Use `bun test`. Write isolated, idempotent tests. Do not mock internal application logic. real.
6. test should clean on every run with creator destroyer

=== DONE

I want DRY in tests/ dir because many redundant setup, also fix below fail

=== DOING

based on readme.md , implement test cases . codebase compliance rules;

1. No OOP, only HOFs
2. Use bun.sh and e2e type safe TypeScript
3. No unknown or any type
4. tests/[e2e|integration|unit]/[domain].test.ts files & dirs
5. Use `bun test`. Write isolated, idempotent tests. Do not mock internal application logic. real.
6. test should clean on every run with creator destroyer

=== DONE

implement eslint and bun tsc -b works fine

=== DONE

based on current providers/whatsmeow setup, is it already met readme.md requirements and strategies?

=== DONE

would you push build image to docker hub, already logged in. so that on every run the app prioritize pulling than building. but do not delete building , just last priority

=== DONE

understand readme.md , then clone https://github.com/tulir/whatsmeow.git to providers/whatsmeow/src , then understand the repo to make perfect providers/whatsmeow/Dockerfile and docker compose by iterating until you can access health and status from container.

1. in providers/whatsmeow/ dir should be no any files than Dockerfile and docker-compose.yml
2. make sure the docker recipes; 

 - ✅ No manual intervention needed
 - ✅ Always gets latest version  of repos/ deps automatically, if already latest dont download
 - ✅ No source files alongside Docker files
 - ✅ Works perfectly in CI/CD pipelines
 - ✅ Efficient (only downloads when and what needed)
 - ✅ should always have idempotency mindset
 - ✅ should auto clean on build destroy only by docker recipe.
 - ✅ should be no any automation script than docker recipe.
 
 
3. after everything done, I want to know below for scalability

  - how many seconds needed when there is another new phone number until user can scan qr.
  - how much ram use for whatsmeow
  - how much ram use for whatsmeow + its docker daemon

==== DONE

understand readme.md then plan! proritize the whatsmeow provider first
