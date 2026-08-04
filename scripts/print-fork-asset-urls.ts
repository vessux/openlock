// CI-only helper for the live-integration preflight step (bd openlock-lpc
// part 2, test.yml). Prints, one per line, the fork release asset URLs this
// host would actually download — the workflow HEAD-checks each before
// paying for podman/subuid setup, so an unpublished-release 404 fails in
// seconds with a clear message instead of ~10min into gateway startup.
import { expectedForkAssetUrls } from "../src/sandbox/fork-binaries";

for (const url of expectedForkAssetUrls()) {
  console.log(url);
}
