// The repository and branch that define "owner-merged". These are CONSTANTS in the hashed runner folder, not values read from the anchor file or from
// .git/config: the anchor is agent-writable, so a location taken from it would let a swapped anchor name its own branch and satisfy commit-on-main.
// Changing them is a code change, visible in a reviewed PR on the pinned repository.
export const PINNED_REPO_URL = "https://github.com/genxttech/danceflow-app.git";
export const PINNED_BRANCH = "main";
export const PINNED_REF = `refs/heads/${PINNED_BRANCH}`;
