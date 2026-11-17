import { verifyBlomp } from "../storage/blomp-verify";
import { BlompError } from "../storage/blomp";

void verifyBlomp(process.env, process.argv.slice(2), (step) =>
  process.stdout.write(step + "\n"),
).catch((error: unknown) => {
  // Never print raw SDK/fetch errors, causes, config, tokens, keys or signed URLs.
  process.stderr.write(
    (error instanceof BlompError ? error.code : "BLOMP_VERIFICATION_FAILED") +
      "\n",
  );
  process.exitCode = 1;
});
