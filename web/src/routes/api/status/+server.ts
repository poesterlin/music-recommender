import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => Response.json('OK');
