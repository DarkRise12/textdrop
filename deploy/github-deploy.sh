#!/bin/bash
# Install as root-owned /usr/local/sbin/textdrop-deploy on the server.
# stdin: docker save stream. Argument: full commit SHA from a trusted workflow.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
[[ $# == 1 && "$1" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected full commit SHA' >&2; exit 2; }
cd /home/darkrise/textdrop
mkdir -p .deploy
exec 9>.deploy/deploy.lock
flock -w 900 9
python3 deploy/setup-docker-secrets.py --check
container=$(docker compose ps -q textdrop)
[[ -n "$container" ]] || { echo 'Initial installation must be running before auto-deploy.' >&2; exit 1; }
previous=$(docker inspect --format '{{.Image}}' "$container")
# Keep the previous image independently of the moving build tag.
docker tag "$previous" textdrop-rollback:previous
revision=$1
image="textdrop-release:$revision"
docker load
[[ $(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image") == "$revision" ]]
# This helper must be installed with the initial manual update (see GITHUB.md).
sh deploy/backup.sh
healthy() {
    local id status
    for ((attempt=0; attempt<60; attempt++)); do
        id=$(docker compose ps -q textdrop)
        if [[ -n "$id" ]]; then
            status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")
            [[ "$status" != healthy ]] || return 0
            [[ "$status" != exited && "$status" != dead && "$status" != unhealthy ]] || return 1
        fi
        sleep 2
    done
    return 1
}
# Persist selected image separately from Compose's .env (which may hold secrets).
# Local administrative commands must source this selection, see GITHUB.md.
if TEXTDROP_IMAGE="$image" docker compose up -d --no-build --force-recreate textdrop && healthy; then
    printf 'export TEXTDROP_IMAGE=%q\n' "$image" > .deploy/image.env.tmp
    mv .deploy/image.env.tmp .deploy/image.env
    echo "Deployed $revision"
else
    echo 'Health check failed; restoring previous application image.' >&2
    TEXTDROP_IMAGE=textdrop-rollback:previous docker compose up -d --no-build --force-recreate textdrop
    if healthy; then
        printf 'export TEXTDROP_IMAGE=textdrop-rollback:previous\n' > .deploy/image.env
        echo 'Previous image restored; deployment failed.' >&2
    else
        echo 'ROLLBACK FAILED: check docker compose logs textdrop immediately.' >&2
    fi
    exit 1
fi
