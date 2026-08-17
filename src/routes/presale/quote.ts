declare const require: any;

import { createJsonResponse, createOptionsResponse } from '../_helpers';

const presaleService = require('../../services/presaleService');
const rateLimiter = require('../../services/rateLimiter');

export function OPTIONS(request: Request): Response {
  return createOptionsResponse(request);
}

export async function POST(request: Request): Promise<Response> {
  if (!rateLimiter.allow('presale-quote', getRequestAddress(request))) {
    return createJsonResponse(request, { error: 'Too many requests' }, 429);
  }
  try {
    return createJsonResponse(request, await presaleService.createQuote(await request.json()));
  } catch (error: any) {
    return createJsonResponse(request, { error: error?.message || 'Unable to create quote' }, 400);
  }
}

function getRequestAddress(request: Request): string {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'unknown';
}
