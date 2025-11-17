
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

==== DONE

understand readme.md then plan! proritize the whatsmeow provider first
