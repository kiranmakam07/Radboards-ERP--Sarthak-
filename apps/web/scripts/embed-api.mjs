import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * On a server, the web app and the API are two programs and /api is passed from one to the other.
 * Vercel runs one deployment, so there the API is put inside the web app: this writes the /api
 * route that hands every request to it. Run by `npm run vercel-build`, never in a normal build,
 * which is why the file it writes is not kept in the repository.
 */
const route = `// Written by scripts/embed-api.mjs. Do not edit or commit: change the script instead.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handle } from '../../../api/src/serverless';

// The API reads the request body and sends the response itself.
export const config = { api: { bodyParser: false, externalResolver: true, responseLimit: false } };

export default function api(req: IncomingMessage, res: ServerResponse) {
  return handle(req, res);
}
`;

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pages', 'api');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, '[...path].ts'), route);
console.log('The API is now part of the web app, behind /api.');
