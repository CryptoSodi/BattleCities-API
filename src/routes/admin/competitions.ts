declare const require: any;
import { createJsonResponse, createOptionsResponse } from '../_helpers';
import { isResponse, requireAdmin } from './_helpers';
const settings = require('../../services/competitionConfig');

export function OPTIONS(request: Request): Response { return createOptionsResponse(request); }
export async function GET(request: Request): Promise<Response> {
  const admin = await requireAdmin(request);
  if (isResponse(admin)) return admin;
  return createJsonResponse(request, { ok: true, settings: await settings.get() });
}
export async function PUT(request: Request): Promise<Response> {
  const admin = await requireAdmin(request);
  if (isResponse(admin)) return admin;
  try {
    const body = await request.json();
    const value = await settings.update(body.settings || body, (admin as any).player?.id || 'admin');
    return createJsonResponse(request, { ok: true, settings: value });
  } catch (error: any) {
    return createJsonResponse(request, { ok: false, error: error.message || 'Invalid settings' }, 400);
  }
}
