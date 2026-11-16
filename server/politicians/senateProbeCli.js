// Reachability check for efdsearch.senate.gov. Logs status codes and a short
// body snippet. Does not read or print secrets, and does not write the database.
// Exit 0 either way so the workflow log is the result.

import { probeSenateAccess } from './senateFetch.js';

export async function main(deps = {}) {
  const logger = deps.logger || console;
  try {
    await probeSenateAccess({
      fetchImpl: deps.fetchImpl || globalThis.fetch,
      logger,
    });
    return 0;
  } catch (err) {
    logger.log(`[senate-probe] result=error message=${JSON.stringify(String(err?.message || err))}`);
    return 0;
  }
}

const invoked = process.argv[1] && process.argv[1].endsWith('senateProbeCli.js');
if (invoked) {
  main().then((code) => process.exit(code));
}
