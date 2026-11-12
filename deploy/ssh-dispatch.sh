#!/bin/bash
# Forced command for the dedicated Actions key; never eval SSH input.
set -eu
if [[ "${SSH_ORIGINAL_COMMAND:-}" == textdrop-probe ]]; then
    code=0
    sudo -n /usr/local/sbin/textdrop-deploy invalid >/dev/null 2>&1 || code=$?
    [[ "$code" == 2 ]] || exit 1
    echo 'Textdrop deployment access ready'
elif [[ "${SSH_ORIGINAL_COMMAND:-}" =~ ^sudo\ -n\ /usr/local/sbin/textdrop-deploy\ ([0-9a-f]{40})$ ]]; then
    exec sudo -n /usr/local/sbin/textdrop-deploy "${BASH_REMATCH[1]}"
else
    echo 'Only Textdrop deployment commands are allowed' >&2
    exit 1
fi
